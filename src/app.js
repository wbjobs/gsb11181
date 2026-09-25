import { CounterStore } from './counter-store.js'

const params = new URLSearchParams(window.location.search)
const isAgent = params.get('agent') === '1'
const runId = params.get('run') ?? ''
const agentId = params.get('agentId') ?? ''
const dbName = params.get('db') ?? undefined

const valueElement = document.querySelector('#counter-value')
const connectionElement = document.querySelector('#connection-status')
const logElement = document.querySelector('#log-status')
const errorElement = document.querySelector('#error-message')
const targetForm = document.querySelector('#target-form')
const targetInput = document.querySelector('#target-input')
const agentBadge = document.querySelector('#agent-badge')
const actionButtons = document.querySelectorAll('[data-action]')

const store = new CounterStore({ dbName })
let busyCount = 0

function render() {
  valueElement.textContent = String(store.value)
  logElement.textContent = `已持久化 ${store.operationCount} 个操作`
  connectionElement.textContent = store.isOnline ? '在线 · 已同步' : '离线 · 恢复后合并'
  document.body.dataset.busy = busyCount > 0 ? 'true' : 'false'
  for (const button of actionButtons) {
    button.disabled = busyCount > 0
  }
}

function setBusy(isBusy) {
  busyCount = Math.max(0, busyCount + (isBusy ? 1 : -1))
  render()
}

function showError(error) {
  errorElement.textContent = error?.message ? `操作失败：${error.message}` : ''
}

async function runAction(action) {
  showError(null)
  setBusy(true)
  try {
    if (action === 'increment') {
      await store.increment()
    } else if (action === 'decrement') {
      await store.decrement()
    } else if (action === 'reset') {
      await store.reset()
    }
  } catch (error) {
    showError(error)
  } finally {
    setBusy(false)
  }
}

for (const button of actionButtons) {
  button.addEventListener('click', () => runAction(button.dataset.action))
}

targetForm.addEventListener('submit', async (event) => {
  event.preventDefault()
  showError(null)

  const targetValue = Number.parseInt(targetInput.value, 10)
  if (!Number.isSafeInteger(targetValue) || targetInput.value.trim() === '') {
    showError(new Error('目标值必须是安全整数。'))
    return
  }

  setBusy(true)
  try {
    await store.setTarget(targetValue)
    targetInput.value = ''
  } catch (error) {
    showError(error)
  } finally {
    setBusy(false)
  }
})

store.addEventListener('statechange', render)
window.addEventListener('online', render)
window.addEventListener('offline', render)

if (isAgent) {
  agentBadge.hidden = false
}

store
  .start()
  .then(render)
  .catch((error) => {
    render()
    showError(error)
  })

if (isAgent) {
  window.counterStore = store

  async function repeat(action, count, value) {
    for (let index = 0; index < count; index += 1) {
      if (action === 'increment') {
        await store.increment()
      } else if (action === 'decrement') {
        await store.decrement()
      } else if (action === 'reset') {
        await store.reset()
      } else if (action === 'set-target') {
        await store.setTarget(value)
      }
    }
  }

  window.addEventListener('message', async (event) => {
    if (window.opener === null || event.source !== window.opener) {
      return
    }

    const command = event.data
    if (!command || command.type !== 'counter-command') {
      return
    }

    const reply = (payload) => {
      window.opener.postMessage({
        type: 'counter-result',
        id: command.id,
        agent: command.agent,
        run: command.run,
        source: 'counter-agent',
        ...payload
      }, window.location.origin)
    }

    try {
      switch (command.action) {
        case 'ping':
          reply({ ok: true, value: store.value, operationCount: store.operationCount })
          break
        case 'increment-many':
          repeat('increment', command.count).then(
            () => reply({ ok: true, value: store.value, operationCount: store.operationCount }),
            (error) => reply({ ok: false, error: error.message })
          )
          break
        case 'decrement-many':
          await repeat('decrement', command.count)
          reply({ ok: true, value: store.value, operationCount: store.operationCount })
          break
        case 'reset':
          await store.reset()
          reply({ ok: true, value: store.value, operationCount: store.operationCount })
          break
        case 'set-target':
          await store.setTarget(command.value)
          reply({ ok: true, value: store.value, operationCount: store.operationCount })
          break
        case 'pause-channel':
          store.pauseChannelForTesting()
          reply({ ok: true, value: store.value, operationCount: store.operationCount })
          break
        case 'resume-channel':
          await store.resumeChannelForTesting()
          reply({ ok: true, value: store.value, operationCount: store.operationCount })
          break
        case 'reconcile':
          await store.reconcile('test-command')
          reply({ ok: true, value: store.value, operationCount: store.operationCount })
          break
        case 'reload':
          reply({ ok: true, reloading: true })
          window.setTimeout(() => window.location.reload(), 50)
          break
        case 'close':
          reply({ ok: true, closing: true })
          window.setTimeout(() => window.close(), 50)
          break
        default:
          reply({ ok: false, error: `Unknown action: ${command.action}` })
      }
    } catch (error) {
      reply({ ok: false, error: error.message })
    }
  })

  window.opener.postMessage(
    { type: 'counter-ready', source: 'counter-agent', run: runId, agent: agentId },
    window.location.origin
  )
}
