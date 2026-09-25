export const ACTION_TYPES = Object.freeze({
  INCREMENT: 'increment',
  DECREMENT: 'decrement',
  RESET: 'reset',
  SET_TARGET: 'set-target'
})

const ACTION_TYPE_VALUES = new Set(Object.values(ACTION_TYPES))

export function createOperationId(source, seq) {
  return `${source}:${seq}`
}

export function createOperation({ source, seq, clock, type, value, createdAt = Date.now() }) {
  if (typeof source !== 'string' || source.length === 0) {
    throw new TypeError('Operation source must be a non-empty string.')
  }
  if (!Number.isSafeInteger(seq) || seq < 1) {
    throw new TypeError('Operation sequence must be a positive safe integer.')
  }
  if (!Number.isSafeInteger(clock) || clock < 1) {
    throw new TypeError('Operation clock must be a positive safe integer.')
  }
  if (!ACTION_TYPE_VALUES.has(type)) {
    throw new TypeError(`Unsupported operation type: ${type}`)
  }
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) {
    throw new TypeError('Operation timestamp must be a non-negative safe integer.')
  }

  const operation = {
    id: createOperationId(source, seq),
    source,
    seq,
    clock,
    type,
    createdAt
  }

  if (type === ACTION_TYPES.SET_TARGET) {
    if (!Number.isSafeInteger(value)) {
      throw new TypeError('Target value must be a safe integer.')
    }
    operation.value = value
  }

  return Object.freeze(operation)
}

export function compareOperations(left, right) {
  if (left.clock !== right.clock) {
    return left.clock - right.clock
  }
  if (left.source !== right.source) {
    return left.source < right.source ? -1 : 1
  }
  return left.seq - right.seq
}

export function dedupeOperations(operations) {
  const byId = new Map()
  for (const operation of operations) {
    if (!byId.has(operation.id)) {
      byId.set(operation.id, operation)
    }
  }
  return byId
}

export function getSnapshot(operations = []) {
  const operationsById = dedupeOperations(operations)
  const sortedOperations = [...operationsById.values()].sort(compareOperations)
  const nextSeqBySource = new Map()

  let value = 0
  let maxClock = 0

  for (const operation of sortedOperations) {
    switch (operation.type) {
      case ACTION_TYPES.INCREMENT:
        value += 1
        break
      case ACTION_TYPES.DECREMENT:
        value -= 1
        break
      case ACTION_TYPES.RESET:
        value = 0
        break
      case ACTION_TYPES.SET_TARGET:
        value = operation.value
        break
    }

    maxClock = Math.max(maxClock, operation.clock)
    nextSeqBySource.set(
      operation.source,
      Math.max(nextSeqBySource.get(operation.source) ?? 0, operation.seq) + 1
    )
  }

  return Object.freeze({
    value,
    maxClock,
    operationCount: sortedOperations.length,
    nextSeqBySource
  })
}

export const INITIAL_SNAPSHOT = Object.freeze(getSnapshot([]))

export function nextOperationFromState(snapshot, { source, type, value }) {
  if (!snapshot || !snapshot.nextSeqBySource) {
    throw new TypeError('A valid counter snapshot is required.')
  }

  return createOperation({
    source,
    seq: snapshot.nextSeqBySource.get(source) ?? 1,
    clock: snapshot.maxClock + 1,
    type,
    value
  })
}
