import type { TripRecord } from '../types/trip';
import type { StorageAdapter } from './StorageAdapter';

const DB_NAME = 'lets-go-commute';
const DB_VERSION = 1;
const TRIP_STORE = 'tripRecords';
const SETTINGS_STORE = 'settings';

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

export class IndexedDBStorageAdapter implements StorageAdapter {
  private dbPromise: Promise<IDBDatabase> | null = null;

  private open(): Promise<IDBDatabase> {
    if (this.dbPromise) {
      return this.dbPromise;
    }

    this.dbPromise = new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) {
        reject(new Error('이 브라우저는 IndexedDB를 지원하지 않습니다.'));
        return;
      }

      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = () => {
        const db = request.result;

        if (!db.objectStoreNames.contains(TRIP_STORE)) {
          const tripStore = db.createObjectStore(TRIP_STORE, { keyPath: 'id' });
          tripStore.createIndex('startedAt', 'startedAt');
        }

        if (!db.objectStoreNames.contains(SETTINGS_STORE)) {
          db.createObjectStore(SETTINGS_STORE, { keyPath: 'key' });
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(request.error ?? new Error('IndexedDB를 열지 못했습니다.'));
    });

    return this.dbPromise;
  }

  async getAllTrips(): Promise<TripRecord[]> {
    const db = await this.open();
    const transaction = db.transaction(TRIP_STORE, 'readonly');
    const store = transaction.objectStore(TRIP_STORE);
    const trips = await requestToPromise<TripRecord[]>(store.getAll());

    return trips.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  async getTripById(id: string): Promise<TripRecord | null> {
    const db = await this.open();
    const transaction = db.transaction(TRIP_STORE, 'readonly');
    const store = transaction.objectStore(TRIP_STORE);
    const trip = await requestToPromise<TripRecord | undefined>(store.get(id));

    return trip ?? null;
  }

  async saveTrip(trip: TripRecord): Promise<void> {
    const db = await this.open();
    const transaction = db.transaction(TRIP_STORE, 'readwrite');
    const store = transaction.objectStore(TRIP_STORE);

    await requestToPromise(store.put(trip));
  }

  async deleteTrip(id: string): Promise<void> {
    const db = await this.open();
    const transaction = db.transaction(TRIP_STORE, 'readwrite');
    const store = transaction.objectStore(TRIP_STORE);

    await requestToPromise(store.delete(id));
  }

  async clearAllTrips(): Promise<void> {
    const db = await this.open();
    const transaction = db.transaction(TRIP_STORE, 'readwrite');
    const store = transaction.objectStore(TRIP_STORE);

    await requestToPromise(store.clear());
  }
}

export const storageAdapter = new IndexedDBStorageAdapter();
