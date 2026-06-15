import type { TripRecord } from '../types/trip';

export interface StorageAdapter {
  getAllTrips(): Promise<TripRecord[]>;
  getTripById(id: string): Promise<TripRecord | null>;
  saveTrip(trip: TripRecord): Promise<void>;
  deleteTrip(id: string): Promise<void>;
  clearAllTrips(): Promise<void>;
}
