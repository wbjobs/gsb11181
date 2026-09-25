import { CounterDatabase, DEFAULT_DB_NAME } from './counter-db.js'
import { ACTION_TYPES, INITIAL_SNAPSHOT, getSnapshot } from './counter-logic.js'

export const CHANNEL_NAME = 'shared-counter-v1'
const RECOVERY_INTERVAL_MS = 3000

function createSourceId() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID()
  }
  return `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
}

export class CounterStore extends EventTarget {
  constructor({ dbName = DEFAULT_DB_NAME, source = createSourceId() } = {}) {
    super()
    this.source = source
    this.database = new CounterDatabase(dbName)
    this.snapshot = INITIAL_SNAPSHOT
    this.readyPromise = null
    this.workChain = Promise.resolve()
    this.reconcileScheduled = false
    this.channelPaused = false
    this.channel = null
    this.recoveryTimer = null
  }

  start() {
    if (!this.readyPromise) {
      this.readyPromise = this.initialize()
    }
    return this.readyPromise
  }

  async initialize() {
    const operations = await this.database.getAllOperations()
    this.snapshot = getSnapshot(operations)

    if (typeof BroadcastChannel !== 'undefined') {
      this.channel = new BroadcastChannel(CHANNEL_NAME)
      this.channel.onmessage = (event) => this.handleChannelMessage(event)
    }

    window.addEventListener('online', this.handleOnline)
    document.addEventListener('visibilitychange', this.handleVisibilityChange)

    this.recoveryTimer = window.setInterval(() => {
      this.scheduleReconcile('recovery-tick')
    }, RECOVERY_INTERVAL_MS)

    this.emitChange('ready')
    return this.snapshot
  }

  increment() {
    return this.append(ACTION_TYPES.INCREMENT)
  }

  decrement() {
    return this.append(ACTION_TYPES.DECREMENT)
  }

  reset() {
    return this.append(ACTION_TYPES.RESET)
  }

  setTarget(value) {
    return this.append(ACTION_TYPES.SET_TARGET, value)
  }

  append(type, value) {
    return this.enqueue(() => this.appendNow(type, value))
  }

  reconcile(reason = 'manual') {
    return this.enqueue(() => this.reconcileNow(reason))
  }

  async appendNow(type, value) {
    await this.start()
    const result = await this.database.appendOperation({
      source: this.source,
      type,
      value
    })

    this.snapshot = result.snapshot
    this.postMessage({
      kind: 'operation',
      source: this.source,
      operation: result.operation
    })
    this.emitChange(type)
    return result.operation
  }

  async reconcileNow(reason) {
    await this.start()
    const operations = await this.database.getAllOperations()
    const nextSnapshot = getSnapshot(operations)
    const previousSnapshot = this.snapshot

    this.snapshot = nextSnapshot

    if (
      previousSnapshot.value !== nextSnapshot.value ||
      previousSnapshot.operationCount !== nextSnapshot.operationCount ||
      previousSnapshot.maxClock !== nextSnapshot.maxClock
    ) {
      this.emitChange(reason)
    }

    return nextSnapshot
  }

  enqueue(work) {
    const result = this.workChain.then(work, work)
    this.workChain = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  scheduleReconcile(reason) {
    if (this.reconcileScheduled) {
      return Promise.resolve(this.snapshot)
    }

    this.reconcileScheduled = true
    return Promise.resolve().then(() => {
      this.reconcileScheduled = false
      return this.reconcile(reason)
    })
  }

  handleChannelMessage(event) {
    if (this.channelPaused) {
      return
    }

    const message = event.data
    if (!message || message.source === this.source) {
      return
    }

    this.scheduleReconcile(`channel:${message.kind ?? 'unknown'}`)
  }

  handleOnline = () => {
    this.reconcile('online')
    this.postMessage({ kind: 'online', source: this.source })
  }

  handleVisibilityChange = () => {
    if (!document.hidden) {
      this.scheduleReconcile('visible')
    }
  }

  pauseChannelForTesting() {
    this.channelPaused = true
  }

  resumeChannelForTesting() {
    if (!this.channelPaused) {
      return
    }
    this.channelPaused = false
    return this.reconcile('channel-resumed')
  }

  postMessage(message) {
    if (this.channel && !this.channelPaused) {
      this.channel.postMessage(message)
    }
  }

  emitChange(reason) {
    this.dispatchEvent(
      new CustomEvent('statechange', {
        detail: {
          reason,
          snapshot: this.snapshot,
          source: this.source
        }
      })
    )
  }

  get value() {
    return this.snapshot.value
  }

  get operationCount() {
    return this.snapshot.operationCount
  }

  get isOnline() {
    return navigator.onLine ?? true
  }

  close() {
    window.removeEventListener('online', this.handleOnline)
    document.removeEventListener('visibilitychange', this.handleVisibilityChange)
    if (this.recoveryTimer !== null) {
      clearInterval(this.recoveryTimer)
    }
    if (this.channel) {
      this.channel.close()
      this.channel = null
    }
    this.database.close()
  }
}
