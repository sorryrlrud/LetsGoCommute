export type TransportMode =
  | 'walk'
  | 'bus'
  | 'subway'
  | 'train'
  | 'bike'
  | 'kickboard'
  | 'public_transport'
  | 'other';

export type CheckpointType =
  | 'start'
  | 'end'
  | 'bus_stop'
  | 'subway_station'
  | 'train_station'
  | 'transfer'
  | 'building_entrance'
  | 'crosswalk'
  | 'store'
  | 'other'
  | null;

export interface GpsPoint {
  lat: number;
  lng: number;
  accuracy: number | null;
  recordedAt: string;
}

export interface Checkpoint {
  id: string;
  type: CheckpointType;
  name: string;
  lat: number;
  lng: number;
  accuracy: number | null;
  recordedAt: string;
  order: number;
  memo: string;
}

export interface Segment {
  id: string;
  fromCheckpointId: string;
  toCheckpointId: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  transportMode: TransportMode | null;
  memo: string;
}

export interface PauseRange {
  startedAt: string;
  endedAt: string;
  durationMs: number;
}

export interface TripRecord {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  startedAt: string;
  endedAt: string | null;
  totalDurationMs: number;
  pausedDurationMs: number;
  visibility: 'private' | 'public';
  nickname: string | null;
  userId: string | null;
  routeGroupId: string | null;
  points: GpsPoint[];
  checkpoints: Checkpoint[];
  segments: Segment[];
  pauseRanges: PauseRange[];
  memo: string;
  appVersion: string;
}

export type RecordingStatus =
  | 'idle'
  | 'recording'
  | 'paused'
  | 'finished'
  | 'editing'
  | 'saved';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export const transportModeLabels: Record<TransportMode, string> = {
  walk: '도보',
  bus: '버스',
  subway: '지하철',
  train: '기차',
  bike: '자전거',
  kickboard: '킥보드',
  public_transport: '기타 대중교통',
  other: '기타',
};

export const checkpointTypeLabels: Record<Exclude<CheckpointType, null>, string> =
  {
    start: '출발지',
    end: '도착지',
    bus_stop: '버스정류장',
    subway_station: '지하철역',
    train_station: '기차역',
    transfer: '환승지',
    building_entrance: '건물 입구',
    crosswalk: '횡단보도',
    store: '편의점/상점',
    other: '기타',
  };
