import { CHANNEL_NAME } from './counter-store.js'

const runButton = document.querySelector('#run-tests')
const statusElement = document.querySelector('#stress-status')
const logElement = document.querySelector('#stress-log')

const TAB_COUNT = 4
const INCREMENTS_PER_TAB = 100
const RECOVERY_SLICE = 3500

const agentWindows = new Map()
const pendingCommands = new Map()
const readyWaiters = new Map()
let activeRunId = ''
let acceptanceDbName = ''
let commandSerial = 0

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function log(message) {
  logElement.textContent += `${new Date().toLocaleTimeString()}  ${message}\n`
}

function setStatus(message, failed = false) {
  statusElement.textContent = message
  statusElement.style.background = failed ? '#fecaca' : '#e0e7ff'
  statusElement.style.color = failed ? '#991b1b' : '#3730a3'
}

function waitForResult(commandId, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingCommands.delete(commandId)
      reject(new Error(`Command ${commandId} timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    pendingCommands.set(commandId, {
      resolve: (result) => {
        clearTimeout(timer)
        resolve(result)
      },
      reject: (error) => {
        clearTimeout(timer)
        reject(error)
      }
    })
  })
}

function commandForWindow(targetWindow, action, extra = {}) {
  const commandId = `cmd-${Date.now()}-${(commandSerial += 1)}`
  targetWindow.postMessage(
    {
      type: 'counter-command',
      id: commandId,
      action,
      run: activeRunId,
      ...extra
    },
    window.location.origin
  )
  return waitForResult(commandId, extra.timeout ?? 30000)
}

function broadcastCommand(action, extra = {}) {
  return Promise.all(
    [...agentWindows.values()]
      .filter((targetWindow) => !targetWindow.closed)
      .map((targetWindow) => commandForWindow(targetWindow, action, extra))
  )
}

function waitForReady(agentId) {
  if (readyWaiters.has(agentId)) {
    return readyWaiters.get(agentId).promise
  }

  let resolveReady
  let rejectReady
  const promise = new Promise((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
    setTimeout(() => {
      if (readyWaiters.get(agentId)?.promise === promise) {
        readyWaiters.delete(agentId)
        reject(new Error(`等待子窗口 ${agentId} 就绪超时。`))
      }
    }, 10000)
  }).finally(() => {
    if (readyWaiters.get(agentId)?.promise === promise) {
      readyWaiters.delete(agentId)
    }
  })

  readyWaiters.set(agentId, { promise, resolve: resolveReady, reject: rejectReady })
  return promise
}

async function openAgent(index) {
  const agentId = `agent-${index + 1}`
  const readyPromise = waitForReady(agentId)
  const url = new URL(window.location.href)
  url.pathname = '/index.html'
  url.search = new URLSearchParams({
    agent: '1',
    run: activeRunId,
    db: acceptanceDbName,
    agentId
  }).toString()

  const agentWindow = window.open(
    url,
    agentId,
    `width=420,height=520,left=${(index % 4) * 430},top=80`
  )
  if (!agentWindow) {
    throw new Error('浏览器阻止了弹出窗口，请允许弹出窗口后重试。')
  }

  agentWindows.set(agentId, agentWindow)
  await readyPromise
}

window.addEventListener('message', (event) => {
  if (event.origin !== window.location.origin || !event.data) {
    return
  }

  const message = event.data
  if (message.source !== 'counter-agent' || message.run !== activeRunId) {
    return
  }

  if (message.type === 'counter-ready') {
    log(`子窗口 ${message.agent} 已就绪`)
    if (readyWaiters.has(message.agent)) {
      const waiter = readyWaiters.get(message.agent)
      readyWaiters.delete(message.agent)
      waiter.resolve(message)
    }
    return
  }

  if (message.type !== 'counter-result') {
    return
  }

  const pending = pendingCommands.get(message.id)
  if (!pending) {
    return
  }

  pendingCommands.delete(message.id)
  if (message.ok) {
    pending.resolve(message)
  } else {
    pending.reject(new Error(message.error || '子窗口命令失败'))
  }
})

async function openAllAgents() {
  for (let index = 0; index < TAB_COUNT; index += 1) {
    await openAgent(index)
  }
}

async function assertAllEqual(expected, label) {
  const results = await broadcastCommand('reconcile', { timeout: 10000 })
  const values = results.map((result) => result.value)
  const counts = results.map((result) => result.operationCount)

  if (results.length !== TAB_COUNT) {
    throw new Error(`${label}：仍有 ${TAB_COUNT - results.length} 个子窗口未响应`)
  }
  if (!values.every((value) => value === expected)) {
    throw new Error(`${label}：期望所有窗口为 ${expected}，实际为 ${values.join(', ')}`)
  }
  if (new Set(counts).size !== 1) {
    throw new Error(`${label}：各窗口看到的操作数不一致：${counts.join(', ')}`)
  }

  log(`✓ ${label}：4 个窗口均为 ${expected}（${counts[0]} 个操作）`)
}

async function runChecks() {
  log('关闭本页面上一次验收遗留的子窗口…')
  for (const targetWindow of agentWindows.values()) {
    targetWindow.close()
  }
  agentWindows.clear()
  await sleep(300)

  log(`使用独立数据库 ${acceptanceDbName}，不污染日常计数…`)

  await openAllAgents()
  await assertAllEqual(0, '初始状态')

  log(`开始 4 个窗口各加 ${INCREMENTS_PER_TAB} 次…`)
  const incrementCommands = [...agentWindows.values()].map((targetWindow) => {
    return commandForWindow(targetWindow, 'increment-many', { count: INCREMENTS_PER_TAB })
  })
  const incrementResults = await Promise.all(incrementCommands)
  log(`加一任务完成：${incrementResults.map((result) => result.value).join(', ')}`)
  await assertAllEqual(400, '并发加一')

  log('4 个窗口同时重置…')
  const resetCommands = [...agentWindows.values()].map((targetWindow) => {
    return commandForWindow(targetWindow, 'reset')
  })
  await Promise.all(resetCommands)
  await assertAllEqual(0, '同时重置')

  await commandForWindow(agentWindows.get('agent-1'), 'increment-many', { count: 1 })
  await commandForWindow(agentWindows.get('agent-1'), 'close')
  await sleep(600)
  const survivingWindows = [...agentWindows.values()].filter((targetWindow) => !targetWindow.closed)
  if (survivingWindows.length !== TAB_COUNT - 1) {
    throw new Error('关闭测试窗口没有真正关闭。')
  }
  const survivingResults = await Promise.all(
    survivingWindows.map((targetWindow) => commandForWindow(targetWindow, 'reconcile'))
  )
  if (!survivingResults.every((result) => result.value === 1)) {
    throw new Error('标签页关闭后计数丢失。')
  }
  log('✓ 标签页关闭后计数不丢：存活窗口均为 1')

  agentWindows.delete('agent-1')
  await openAgent(0)
  await assertAllEqual(1, '关闭窗口重新打开后计数一致')

  log('暂停一个窗口的实时消息，并在隔离期间执行本地操作…')
  const isolatedWindow = agentWindows.get('agent-2')
  await commandForWindow(isolatedWindow, 'pause-channel')
  await commandForWindow(isolatedWindow, 'increment-many', { count: 5, timeout: 20000 })
  await commandForWindow(isolatedWindow, 'decrement-many', { count: 2, timeout: 20000 })
  await sleep(1000)
  await commandForWindow(isolatedWindow, 'resume-channel')
  await assertAllEqual(4, '离线/断消息操作恢复后合并')

  log('发送重复、乱序和无效 BroadcastChannel 消息…')
  const channel = new BroadcastChannel(CHANNEL_NAME)
  const duplicateMessage = { kind: 'operation', source: 'acceptance-noise', seq: 42 }
  for (let index = 0; index < 5; index += 1) {
    channel.postMessage(duplicateMessage)
  }
  for (let seq = 5; seq >= 1; seq -= 1) {
    channel.postMessage({ kind: 'operation', source: 'acceptance-noise', seq })
  }
  channel.postMessage({ kind: 'unknown', source: 'noise' })
  channel.postMessage(null)
  channel.close()
  await sleep(RECOVERY_SLICE)
  await assertAllEqual(4, '消息乱序、重复、噪声后不丢更新')

  log('刷新两个窗口并等待重新就绪…')
  const reloadReady3 = waitForReady('agent-3')
  const reloadReady4 = waitForReady('agent-4')
  await commandForWindow(agentWindows.get('agent-3'), 'reload')
  await commandForWindow(agentWindows.get('agent-4'), 'reload')
  await Promise.all([reloadReady3, reloadReady4])
  await sleep(500)
  await assertAllEqual(4, '刷新后计数一致')

  await broadcastCommand('set-target', { value: 10 })
  await broadcastCommand('decrement-many', { count: 1 })
  await assertAllEqual(9, '设置目标值与减一')
}

runButton.addEventListener('click', async () => {
  activeRunId = `run-${Date.now()}`
  acceptanceDbName = `shared-counter-acceptance-${Date.now()}`
  logElement.textContent = ''
  runButton.disabled = true
  setStatus('验收运行中…')

  try {
    await runChecks()
    setStatus('全部通过')
    log('\n全部验收通过。')
  } catch (error) {
    setStatus(`验收失败：${error.message}`, true)
    log(`\n✗ ${error.message}`)
  } finally {
    runButton.disabled = false
  }
})
