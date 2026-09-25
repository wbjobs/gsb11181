import { getSnapshot, nextOperationFromState } from './counter-logic.js'

export const DEFAULT_DB_NAME = 'shared-counter-db'
export const DEFAULT_DB_VERSION = 1
export const OPERATIONS_STORE = 'operations'

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export class CounterDatabase {
  constructor(dbName = DEFAULT_DB_NAME) {
    this.dbName = dbName
    this.db = null
  }

  async open(version = DEFAULT_DB_VERSION) {
    if (this.db) {
      return this.db
    }

    if (typeof indexedDB === 'undefined') {
      throw new Error('IndexedDB is not available in this browser.')
    }

    const openRequest = indexedDB.open(this.dbName, version)

    this.db = await new Promise((resolve, reject) => {
      openRequest.onblocked = () => {
        reject(new Error('Another tab is blocking the counter database upgrade.'))
      }
      openRequest.onupgradeneeded = () => {
        const database = openRequest.result
        if (!database.objectStoreNames.contains(OPERATIONS_STORE)) {
          const store = database.createObjectStore(OPERATIONS_STORE, {
            keyPath: 'id'
          })
          store.createIndex('sourceSeq', ['source', 'seq'], { unique: true })
        }
      }
      openRequest.onsuccess = () => resolve(openRequest.result)
      openRequest.onerror = () => reject(openRequest.error)
    })

    this.db.onversionchange = () => {
      this.db.close()
      this.db = null
    }

    return this.db
  }

  async getAllOperations() {
    await this.open()

    const transaction = this.db.transaction(OPERATIONS_STORE, 'readonly')
    const store = transaction.objectStore(OPERATIONS_STORE)
    const operations = await requestToPromise(store.getAll())

    await transactionDone(transaction)
    return operations
  }

  async appendOperation({ source, type, value }) {
    await this.open()

    const transaction = this.db.transaction(OPERATIONS_STORE, 'readwrite')
    const store = transaction.objectStore(OPERATIONS_STORE)
    const existingOperations = await requestToPromise(store.getAll())
    const snapshot = getSnapshot(existingOperations)
    const operation = nextOperationFromState(snapshot, { source, type, value })

    await requestToPromise(store.add(operation))
    await transactionDone(transaction)

    return {
      operation,
      snapshot: getSnapshot([...existingOperations, operation])
    }
  }

  close() {
    if (this.db) {
      this.db.close()
      this.db = null
    }
  }
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error)
  })
}
