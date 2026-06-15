import type { LatLng } from '../types/geo';
import type {
  Checkpoint,
  PauseRange,
  Segment,
  TripRecord,
  TransportMode,
  ValidationResult,
} from '../types/trip';
import { calculateDistanceMeters } from './distance';
import { calculateTotalDuration } from './duration';
import { generateId } from './id';

export function calculatePausedDuration(pauseRanges: PauseRange[]): number {
  return pauseRanges.reduce((total, range) => total + Math.max(0, range.durationMs), 0);
}

export function createSegmentFromCheckpoints(
  fromCheckpoint: Checkpoint,
  toCheckpoint: Checkpoint,
  transportMode: TransportMode | null = null,
): Segment {
  return {
    id: generateId(),
    fromCheckpointId: fromCheckpoint.id,
    toCheckpointId: toCheckpoint.id,
    startedAt: fromCheckpoint.recordedAt,
    endedAt: toCheckpoint.recordedAt,
    durationMs: calculateTotalDuration(fromCheckpoint.recordedAt, toCheckpoint.recordedAt),
    transportMode,
    memo: '',
  };
}

export function buildSegmentsFromCheckpoints(
  checkpoints: Checkpoint[],
  existingSegments: Segment[] = [],
): Segment[] {
  return checkpoints.slice(1).map((checkpoint, index) => {
    const previous = checkpoints[index];
    const existingSegment = existingSegments.find(
      (segment) =>
        segment.fromCheckpointId === previous.id && segment.toCheckpointId === checkpoint.id,
    );

    return {
      id: existingSegment?.id ?? generateId(),
      fromCheckpointId: previous.id,
      toCheckpointId: checkpoint.id,
      startedAt: previous.recordedAt,
      endedAt: checkpoint.recordedAt,
      durationMs: calculateTotalDuration(previous.recordedAt, checkpoint.recordedAt),
      transportMode: existingSegment?.transportMode ?? null,
      memo: existingSegment?.memo ?? '',
    };
  });
}

export function firstCheckpoint(trip: TripRecord): LatLng | null {
  const checkpoint = trip.checkpoints[0];
  return checkpoint ? { lat: checkpoint.lat, lng: checkpoint.lng } : null;
}

export function lastCheckpoint(trip: TripRecord): LatLng | null {
  const checkpoint = trip.checkpoints.at(-1);
  return checkpoint ? { lat: checkpoint.lat, lng: checkpoint.lng } : null;
}

export function findSimilarTrips(
  baseTrip: TripRecord,
  trips: TripRecord[],
): TripRecord[] {
  const baseStart = firstCheckpoint(baseTrip);
  const baseEnd = lastCheckpoint(baseTrip);

  if (!baseStart || !baseEnd) {
    return [];
  }

  return trips
    .filter((trip) => trip.id !== baseTrip.id)
    .filter((trip) => {
      const start = firstCheckpoint(trip);
      const end = lastCheckpoint(trip);

      if (!start || !end) {
        return false;
      }

      return (
        calculateDistanceMeters(baseStart, start) <= 100 &&
        calculateDistanceMeters(baseEnd, end) <= 100
      );
    })
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export function validateTripBeforeSave(trip: TripRecord): ValidationResult {
  const errors: string[] = [];

  if (trip.checkpoints.length < 2) {
    errors.push('체크포인트가 최소 2개 이상 필요합니다.');
  }

  if (trip.checkpoints.some((checkpoint) => checkpoint.name.trim().length === 0)) {
    errors.push('모든 체크포인트 이름을 입력해주세요.');
  }

  if (trip.segments.some((segment) => segment.transportMode === null)) {
    errors.push('모든 구간의 이동수단을 지정해주세요.');
  }

  if (!trip.startedAt) {
    errors.push('출발 시각이 없습니다.');
  }

  if (!trip.endedAt) {
    errors.push('도착 시각이 없습니다.');
  }

  if (trip.points.length < 1) {
    errors.push('GPS 포인트가 최소 1개 이상 필요합니다.');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

export function getPrimaryTransportMode(trip: TripRecord): string {
  const counts = new Map<string, number>();

  for (const segment of trip.segments) {
    if (!segment.transportMode) {
      continue;
    }

    counts.set(segment.transportMode, (counts.get(segment.transportMode) ?? 0) + 1);
  }

  const primary = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return primary?.[0] ?? 'other';
}
