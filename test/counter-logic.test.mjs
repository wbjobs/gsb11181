import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  ACTION_TYPES,
  compareOperations,
  createOperation,
  dedupeOperations,
  getSnapshot,
  nextOperationFromState
} from '../src/counter-logic.js'

function appendOperation(operations, source, type, value) {
  const snapshot = getSnapshot(operations)
  const operation = nextOperationFromState(snapshot, { source, type, value })
  return [...operations, operation]
}

function shuffled(values) {
  const result = [...values]
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1))
    ;[result[index], result[swapIndex]] = [result[swapIndex], result[index]]
  }
  return result
}

test('four clients can each increment 100 times without losing an update', () => {
  const sources = ['tab-a', 'tab-b', 'tab-c', 'tab-d']
  const operationsBySource = sources.map(() => [])

  for (let count = 0; count < 100; count += 1) {
    const concurrentOperations = operationsBySource.map((operations, index) => {
      const snapshot = getSnapshot(operations)
      return nextOperationFromState(snapshot, {
        source: sources[index],
        type: ACTION_TYPES.INCREMENT
      })
    })

    concurrentOperations.forEach((operation, index) => {
      operationsBySource[index].push(operation)
    })
  }

  const mergedOperations = operationsBySource.flat()

  assert.equal(getSnapshot(mergedOperations).value, 400)
  assert.equal(getSnapshot(shuffled(mergedOperations)).value, 400)
})

test('concurrent reset operations converge to zero', () => {
  const sources = ['tab-a', 'tab-b', 'tab-c', 'tab-d']
  const resetOperations = sources.map((source) => {
    return nextOperationFromState(getSnapshot([]), {
      source,
      type: ACTION_TYPES.RESET
    })
  })

  assert.equal(getSnapshot(shuffled(resetOperations)).value, 0)
})

test('reset and set-target have deterministic total ordering', () => {
  const increment = createOperation({
    source: 'tab-a',
    seq: 1,
    clock: 1,
    type: ACTION_TYPES.INCREMENT
  })
  const reset = createOperation({
    source: 'tab-b',
    seq: 1,
    clock: 2,
    type: ACTION_TYPES.RESET
  })
  const setTarget = createOperation({
    source: 'tab-c',
    seq: 1,
    clock: 3,
    type: ACTION_TYPES.SET_TARGET,
    value: 42
  })

  const ordered = [setTarget, reset, increment].sort(compareOperations)
  assert.deepEqual(ordered.map((operation) => operation.id), [
    'tab-a:1',
    'tab-b:1',
    'tab-c:1'
  ])
  assert.equal(getSnapshot(ordered).value, 42)
})

test('duplicate operations are applied only once', () => {
  let operations = []
  operations = appendOperation(operations, 'tab-a', ACTION_TYPES.INCREMENT)
  operations = appendOperation(operations, 'tab-b', ACTION_TYPES.INCREMENT)

  const duplicated = [...operations, ...operations]
  const deduped = [...dedupeOperations(shuffled(duplicated)).values()]

  assert.equal(getSnapshot(duplicated).value, 2)
  assert.equal(getSnapshot(deduped).value, 2)
  assert.equal(getSnapshot(duplicated).operationCount, 2)
})

test('offline forks are merged after reconnection', () => {
  let commonOperations = []
  commonOperations = appendOperation(commonOperations, 'tab-a', ACTION_TYPES.RESET)

  const offlineA = [...commonOperations]
  const offlineB = [...commonOperations]

  for (let count = 0; count < 5; count += 1) {
    offlineA.push(
      nextOperationFromState(getSnapshot(offlineA), {
        source: 'tab-a',
        type: ACTION_TYPES.INCREMENT
      })
    )
  }
  for (let count = 0; count < 3; count += 1) {
    offlineB.push(
      nextOperationFromState(getSnapshot(offlineB), {
        source: 'tab-b',
        type: ACTION_TYPES.DECREMENT
      })
    )
  }

  assert.equal(getSnapshot([...offlineA, ...offlineB]).value, 2)
})

test('target value and decrement are replayed correctly in any delivery order', () => {
  let operations = []
  operations = appendOperation(operations, 'tab-a', ACTION_TYPES.SET_TARGET, 10)
  operations = appendOperation(operations, 'tab-b', ACTION_TYPES.DECREMENT)
  operations = appendOperation(operations, 'tab-b', ACTION_TYPES.DECREMENT)

  assert.equal(getSnapshot(shuffled(operations)).value, 8)
})
