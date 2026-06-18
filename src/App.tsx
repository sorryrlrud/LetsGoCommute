import {
  AlertCircle,
  Bell,
  BellOff,
  Check,
  GitMerge,
  GitCompareArrows,
  Home,
  Info,
  List,
  LocateFixed,
  MapPin,
  Navigation,
  Pause,
  Pencil,
  Play,
  RotateCcw,
  Save,
  Settings,
  ShieldAlert,
  Square,
  Trash2,
  Trophy,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ConfirmDialog } from './components/ConfirmDialog';
import { MapView } from './components/MapView';
import { TimerDisplay } from './components/TimerDisplay';
import { TransportModeSelect } from './components/TransportModeSelect';
import { TripCard } from './components/TripCard';
import { storageAdapter } from './storage/IndexedDBStorageAdapter';
import type {
  ActiveTripDraft,
  AppSettings,
  Checkpoint,
  CheckpointType,
  DraftCheckpointPrompt,
  DraftRecordingStatus,
  GpsPoint,
  PauseRange,
  RecordingStatus,
  SavedCheckpointPlace,
  Segment,
  TransportMode,
  TripRecord,
} from './types/trip';
import { checkpointTypeLabels, transportModeLabels } from './types/trip';
import { formatDate, formatDateTime, formatTime, generateDefaultTripName } from './utils/date';
import { calculateDistanceMeters } from './utils/distance';
import { formatDelta, formatDuration, calculateTotalDuration } from './utils/duration';
import { generateId } from './utils/id';
import {
  buildSegmentsFromCheckpoints,
  calculatePausedDuration,
  createSegmentFromCheckpoints,
  findSimilarTrips,
  validateTripBeforeSave,
} from './utils/trip';
import './App.css';

const APP_VERSION = '0.1.0';
const GPS_MAX_SAVE_INTERVAL_MS = 5_000;
const GPS_MIN_SAVE_INTERVAL_MS = 1_000;
const GPS_DISTANCE_SAVE_METERS = 8;
const GPS_TURN_SAVE_DEGREES = 35;
const GPS_TURN_MIN_LEG_METERS = 5;
const CHECKPOINT_PLACE_MATCH_RADIUS_METERS = 100;
const DRAFT_STALE_PAUSE_MS = 90_000;

type AppView =
  | 'home'
  | 'recording'
  | 'summary'
  | 'edit'
  | 'records'
  | 'detail'
  | 'compare'
  | 'settings';

interface GpsStatus {
  label: string;
  detail: string;
  tone: 'idle' | 'good' | 'warning' | 'error';
}

interface ConfirmState {
  title: string;
  description: string;
  confirmLabel?: string;
  tone?: 'primary' | 'danger';
  onConfirm: () => void;
}

type CheckpointPromptState = DraftCheckpointPrompt;

interface MapCheckpointEditorState {
  source: 'current' | 'saved';
  tripId: string;
  checkpointId: string;
  recordedAt: string;
  segmentId: string | null;
  name: string;
  type: CheckpointType;
  memo: string;
  transportMode: TransportMode | null;
}

const checkpointTypeOptions = Object.keys(checkpointTypeLabels) as Exclude<
  CheckpointType,
  null
>[];

type NotificationPermissionState = NotificationPermission | 'unsupported';

function createDefaultAppSettings(): AppSettings {
  return {
    key: 'appSettings',
    pushNotificationsEnabled: false,
    updatedAt: new Date().toISOString(),
  };
}

function getInitialNotificationPermission(): NotificationPermissionState {
  if (!('Notification' in window)) {
    return 'unsupported';
  }

  return Notification.permission;
}

function getNotificationPermissionLabel(permission: NotificationPermissionState) {
  if (permission === 'granted') {
    return '허용됨';
  }

  if (permission === 'denied') {
    return '차단됨';
  }

  if (permission === 'default') {
    return '미결정';
  }

  return '지원 안 함';
}

function reindexCheckpoints(checkpoints: Checkpoint[]) {
  return checkpoints.map((checkpoint, order) => ({ ...checkpoint, order }));
}

function isFixedEndpointCheckpoint(trip: TripRecord, index: number) {
  const lastIndex = trip.checkpoints.length - 1;
  return index === 0 || (trip.endedAt !== null && index === lastIndex);
}

function canRemoveCheckpoint(trip: TripRecord, checkpointId: string) {
  const index = trip.checkpoints.findIndex((checkpoint) => checkpoint.id === checkpointId);
  return index >= 0 && !isFixedEndpointCheckpoint(trip, index);
}

function mergeCheckpointMemo(target: Checkpoint, source: Checkpoint) {
  const sourceMemo = source.memo.trim();

  if (sourceMemo.length === 0) {
    return target;
  }

  const targetMemo = target.memo.trim();

  return {
    ...target,
    memo: targetMemo.length > 0 ? `${targetMemo}\n병합: ${sourceMemo}` : sourceMemo,
  };
}

function rebuildTripWithCheckpoints(trip: TripRecord, checkpoints: Checkpoint[]) {
  const orderedCheckpoints = reindexCheckpoints(checkpoints);

  return {
    ...trip,
    checkpoints: orderedCheckpoints,
    segments: buildSegmentsFromCheckpoints(orderedCheckpoints, trip.segments),
    updatedAt: new Date().toISOString(),
  };
}

function removeCheckpointFromTrip(
  trip: TripRecord,
  checkpointId: string,
  mode: 'delete' | 'merge-previous' | 'merge-next',
) {
  const checkpointIndex = trip.checkpoints.findIndex(
    (checkpoint) => checkpoint.id === checkpointId,
  );

  if (checkpointIndex < 0 || isFixedEndpointCheckpoint(trip, checkpointIndex)) {
    return null;
  }

  if (mode === 'merge-previous' && checkpointIndex <= 0) {
    return null;
  }

  if (mode === 'merge-next' && checkpointIndex >= trip.checkpoints.length - 1) {
    return null;
  }

  const checkpoints = [...trip.checkpoints];
  const source = checkpoints[checkpointIndex];

  if (mode === 'merge-previous') {
    checkpoints[checkpointIndex - 1] = mergeCheckpointMemo(
      checkpoints[checkpointIndex - 1],
      source,
    );
  }

  if (mode === 'merge-next') {
    checkpoints[checkpointIndex + 1] = mergeCheckpointMemo(
      checkpoints[checkpointIndex + 1],
      source,
    );
  }

  checkpoints.splice(checkpointIndex, 1);

  return rebuildTripWithCheckpoints(trip, checkpoints);
}

function isDraftRecordingStatus(status: RecordingStatus): status is DraftRecordingStatus {
  return (
    status === 'recording' ||
    status === 'paused' ||
    status === 'finished' ||
    status === 'editing'
  );
}

function getDraftView(status: DraftRecordingStatus): ActiveTripDraft['view'] {
  if (status === 'finished') {
    return 'summary';
  }

  if (status === 'editing') {
    return 'edit';
  }

  return 'recording';
}

function getLastPointSavedAt(trip: TripRecord) {
  return new Date(trip.points.at(-1)?.recordedAt ?? trip.updatedAt).getTime();
}

function toRadians(degrees: number) {
  return (degrees * Math.PI) / 180;
}

function calculateBearingDegrees(from: GpsPoint, to: GpsPoint) {
  const fromLat = toRadians(from.lat);
  const toLat = toRadians(to.lat);
  const lngDelta = toRadians(to.lng - from.lng);
  const y = Math.sin(lngDelta) * Math.cos(toLat);
  const x =
    Math.cos(fromLat) * Math.sin(toLat) -
    Math.sin(fromLat) * Math.cos(toLat) * Math.cos(lngDelta);

  return (Math.atan2(y, x) * 180) / Math.PI;
}

function calculateBearingDeltaDegrees(first: number, second: number) {
  const delta = Math.abs(first - second) % 360;
  return delta > 180 ? 360 - delta : delta;
}

function shouldSaveRoutePoint(trip: TripRecord, point: GpsPoint) {
  const lastPoint = trip.points.at(-1);
  if (!lastPoint) {
    return true;
  }

  const pointTime = new Date(point.recordedAt).getTime();
  const lastPointTime = new Date(lastPoint.recordedAt).getTime();
  const elapsedMs = pointTime - lastPointTime;

  if (elapsedMs < GPS_MIN_SAVE_INTERVAL_MS) {
    return false;
  }

  const distanceMeters = calculateDistanceMeters(lastPoint, point);
  if (distanceMeters >= GPS_DISTANCE_SAVE_METERS) {
    return true;
  }

  if (elapsedMs >= GPS_MAX_SAVE_INTERVAL_MS && distanceMeters >= 2) {
    return true;
  }

  const previousPoint = trip.points.at(-2);
  if (!previousPoint || distanceMeters < GPS_TURN_MIN_LEG_METERS) {
    return false;
  }

  const previousLegMeters = calculateDistanceMeters(previousPoint, lastPoint);
  if (previousLegMeters < GPS_TURN_MIN_LEG_METERS) {
    return false;
  }

  const turnDegrees = calculateBearingDeltaDegrees(
    calculateBearingDegrees(previousPoint, lastPoint),
    calculateBearingDegrees(lastPoint, point),
  );

  return turnDegrees >= GPS_TURN_SAVE_DEGREES;
}

function positionToPoint(position: GeolocationPosition, recordedAt = new Date().toISOString()) {
  return {
    lat: position.coords.latitude,
    lng: position.coords.longitude,
    accuracy: Number.isFinite(position.coords.accuracy) ? position.coords.accuracy : null,
    recordedAt,
  };
}

function createCheckpoint(
  point: GpsPoint,
  order: number,
  type: CheckpointType,
  name: string,
): Checkpoint {
  return {
    id: generateId(),
    type,
    name,
    lat: point.lat,
    lng: point.lng,
    accuracy: point.accuracy,
    recordedAt: point.recordedAt,
    order,
    memo: '',
  };
}

function gpsStatusFromPoint(point: GpsPoint): GpsStatus {
  if (point.accuracy !== null && point.accuracy > 80) {
    return {
      label: 'GPS 정확도 낮음',
      detail: `오차 약 ${Math.round(point.accuracy)}m, 1차 MVP에서는 우선 기록합니다.`,
      tone: 'warning',
    };
  }

  return {
    label: '위치 수신 중',
    detail: point.accuracy === null ? '정확도 정보 없음' : `오차 약 ${Math.round(point.accuracy)}m`,
    tone: 'good',
  };
}

function getGeolocationErrorMessage(error: GeolocationPositionError): GpsStatus {
  if (error.code === error.PERMISSION_DENIED) {
    return {
      label: '위치 권한 필요',
      detail: '브라우저 설정에서 위치 권한을 허용해주세요.',
      tone: 'error',
    };
  }

  if (error.code === error.TIMEOUT) {
    return {
      label: '위치 수신 실패',
      detail: '현재 위치 확인 시간이 초과되었습니다. 잠시 후 다시 시도해주세요.',
      tone: 'error',
    };
  }

  return {
    label: '위치 수신 실패',
    detail: '현재 위치를 가져오지 못했습니다. 잠시 후 다시 시도해주세요.',
    tone: 'error',
  };
}

function getInitialGpsStatus(): GpsStatus {
  if (!('geolocation' in navigator)) {
    return {
      label: '위치 사용 불가',
      detail: '이 브라우저에서는 Geolocation API를 사용할 수 없습니다.',
      tone: 'error',
    };
  }

  return {
    label: '위치 확인 중',
    detail: '위치 권한 요청을 준비하고 있습니다.',
    tone: 'idle',
  };
}

function createTripFromStart(point: GpsPoint): TripRecord {
  const startedAt = point.recordedAt;
  const startCheckpoint = createCheckpoint(point, 0, 'start', '출발지');

  return {
    id: generateId(),
    name: generateDefaultTripName(startedAt),
    createdAt: startedAt,
    updatedAt: startedAt,
    startedAt,
    endedAt: null,
    totalDurationMs: 0,
    pausedDurationMs: 0,
    visibility: 'private',
    nickname: null,
    userId: null,
    routeGroupId: null,
    points: [point],
    checkpoints: [startCheckpoint],
    segments: [],
    pauseRanges: [],
    memo: '',
    appVersion: APP_VERSION,
  };
}

function getSegmentLabel(segment: Segment, checkpoints: Checkpoint[]) {
  const from = checkpoints.find((checkpoint) => checkpoint.id === segment.fromCheckpointId);
  const to = checkpoints.find((checkpoint) => checkpoint.id === segment.toCheckpointId);

  return `${from?.name || '출발 체크'} → ${to?.name || '도착 체크'}`;
}

function findCheckpointPlaceMatch(point: GpsPoint, places: SavedCheckpointPlace[]) {
  const candidates = places
    .map((place) => ({
      place,
      distanceMeters: calculateDistanceMeters(point, place),
    }))
    .filter((candidate) => candidate.distanceMeters <= CHECKPOINT_PLACE_MATCH_RADIUS_METERS)
    .sort((a, b) => a.distanceMeters - b.distanceMeters);

  return candidates[0] ?? null;
}

function getLivePausedDuration(trip: TripRecord | null, activePauseStartedAt: string | null, now: number) {
  if (!trip) {
    return 0;
  }

  const completed = calculatePausedDuration(trip.pauseRanges);
  const active = activePauseStartedAt
    ? Math.max(0, now - new Date(activePauseStartedAt).getTime())
    : 0;

  return completed + active;
}

function getLiveTotalDuration(trip: TripRecord | null, now: number) {
  if (!trip) {
    return 0;
  }

  const endMs = trip.endedAt ? new Date(trip.endedAt).getTime() : now;
  return Math.max(0, endMs - new Date(trip.startedAt).getTime());
}

function createMapCheckpointEditorState(
  source: MapCheckpointEditorState['source'],
  trip: TripRecord,
  checkpointId: string,
): MapCheckpointEditorState | null {
  const checkpoint = trip.checkpoints.find((item) => item.id === checkpointId);
  if (!checkpoint) {
    return null;
  }

  const segment = trip.segments.find((item) => item.toCheckpointId === checkpoint.id);

  return {
    source,
    tripId: trip.id,
    checkpointId: checkpoint.id,
    recordedAt: checkpoint.recordedAt,
    segmentId: segment?.id ?? null,
    name: checkpoint.name,
    type: checkpoint.type,
    memo: checkpoint.memo,
    transportMode: segment?.transportMode ?? null,
  };
}

function applyMapCheckpointEditorToTrip(
  trip: TripRecord,
  editor: MapCheckpointEditorState,
): TripRecord {
  const checkpoints = trip.checkpoints.map((checkpoint) =>
    checkpoint.id === editor.checkpointId
      ? {
          ...checkpoint,
          memo: editor.memo,
          name: editor.name,
          type: editor.type,
        }
      : checkpoint,
  );

  const segments = editor.segmentId
    ? trip.segments.map((segment) =>
        segment.id === editor.segmentId
          ? {
              ...segment,
              transportMode: editor.transportMode,
            }
          : segment,
      )
    : trip.segments;

  return {
    ...trip,
    checkpoints,
    segments,
    updatedAt: new Date().toISOString(),
  };
}

function App() {
  const [view, setView] = useState<AppView>('home');
  const [recordingStatus, setRecordingStatus] = useState<RecordingStatus>('idle');
  const [currentTrip, setCurrentTrip] = useState<TripRecord | null>(null);
  const [trips, setTrips] = useState<TripRecord[]>([]);
  const [checkpointPlaces, setCheckpointPlaces] = useState<SavedCheckpointPlace[]>([]);
  const [appSettings, setAppSettings] = useState<AppSettings>(() => createDefaultAppSettings());
  const [notificationPermission, setNotificationPermission] =
    useState<NotificationPermissionState>(() => getInitialNotificationPermission());
  const [currentPosition, setCurrentPosition] = useState<GpsPoint | null>(null);
  const [gpsStatus, setGpsStatus] = useState<GpsStatus>(() => getInitialGpsStatus());
  const [activePauseStartedAt, setActivePauseStartedAt] = useState<string | null>(null);
  const [selectedTripId, setSelectedTripId] = useState<string | null>(null);
  const [comparisonTargetId, setComparisonTargetId] = useState<string | null>(null);
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);
  const [checkpointPrompt, setCheckpointPrompt] = useState<CheckpointPromptState | null>(null);
  const [showCheckpointEditor, setShowCheckpointEditor] = useState(false);
  const [mapCheckpointEditor, setMapCheckpointEditor] =
    useState<MapCheckpointEditorState | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [draftHydrated, setDraftHydrated] = useState(false);
  const [now, setNow] = useState(Date.now());

  const currentTripRef = useRef<TripRecord | null>(currentTrip);
  const checkpointPlacesRef = useRef<SavedCheckpointPlace[]>(checkpointPlaces);
  const appSettingsRef = useRef<AppSettings>(appSettings);
  const checkpointPromptRef = useRef<CheckpointPromptState | null>(checkpointPrompt);
  const recordingStatusRef = useRef<RecordingStatus>(recordingStatus);
  const activePauseStartedAtRef = useRef<string | null>(activePauseStartedAt);
  const showCheckpointEditorRef = useRef(showCheckpointEditor);
  const lastSavedPointAtRef = useRef<number>(0);
  const draftPersistTimerRef = useRef<number | null>(null);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);

  const selectedTrip = useMemo(
    () => trips.find((trip) => trip.id === selectedTripId) ?? null,
    [selectedTripId, trips],
  );

  const validation = useMemo(
    () => (currentTrip ? validateTripBeforeSave(currentTrip) : { valid: false, errors: [] }),
    [currentTrip],
  );

  useEffect(() => {
    currentTripRef.current = currentTrip;
  }, [currentTrip]);

  useEffect(() => {
    checkpointPlacesRef.current = checkpointPlaces;
  }, [checkpointPlaces]);

  useEffect(() => {
    appSettingsRef.current = appSettings;
  }, [appSettings]);

  useEffect(() => {
    checkpointPromptRef.current = checkpointPrompt;
  }, [checkpointPrompt]);

  useEffect(() => {
    recordingStatusRef.current = recordingStatus;
  }, [recordingStatus]);

  useEffect(() => {
    activePauseStartedAtRef.current = activePauseStartedAt;
  }, [activePauseStartedAt]);

  useEffect(() => {
    showCheckpointEditorRef.current = showCheckpointEditor;
  }, [showCheckpointEditor]);

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    void loadTrips();
    void loadCheckpointPlaces();
    void loadAppSettings();
    void restoreActiveTripDraft();
    // Restore runs once before draft autosave is enabled.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!draftHydrated) {
      return;
    }

    if (draftPersistTimerRef.current !== null) {
      window.clearTimeout(draftPersistTimerRef.current);
    }

    if (!currentTrip || !isDraftRecordingStatus(recordingStatus)) {
      draftPersistTimerRef.current = null;
      void storageAdapter.clearActiveTripDraft().catch((error) => {
        setStorageError(error instanceof Error ? error.message : '임시 기록 삭제에 실패했습니다.');
      });
      return;
    }

    const draft = createActiveTripDraft(
      currentTrip,
      recordingStatus,
      activePauseStartedAt,
      checkpointPrompt,
      showCheckpointEditor,
    );

    draftPersistTimerRef.current = window.setTimeout(() => {
      void storageAdapter.saveActiveTripDraft(draft).catch((error) => {
        setStorageError(error instanceof Error ? error.message : '임시 기록 저장에 실패했습니다.');
      });
      draftPersistTimerRef.current = null;
    }, 250);

    return () => {
      if (draftPersistTimerRef.current !== null) {
        window.clearTimeout(draftPersistTimerRef.current);
        draftPersistTimerRef.current = null;
      }
    };
  }, [
    activePauseStartedAt,
    checkpointPrompt,
    currentTrip,
    draftHydrated,
    recordingStatus,
    showCheckpointEditor,
  ]);

  useEffect(() => {
    if (!currentTrip || !isDraftRecordingStatus(recordingStatus)) {
      return;
    }

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [currentTrip, recordingStatus]);

  useEffect(() => {
    const handlePageHide = () => {
      const trip = currentTripRef.current;
      const status = recordingStatusRef.current;

      if (!trip || !isDraftRecordingStatus(status)) {
        return;
      }

      void storageAdapter.saveActiveTripDraft(
        createActiveTripDraft(
          trip,
          status,
          activePauseStartedAtRef.current,
          checkpointPromptRef.current,
          showCheckpointEditorRef.current,
        ),
      );
    };

    window.addEventListener('pagehide', handlePageHide);
    return () => window.removeEventListener('pagehide', handlePageHide);
  }, []);

  useEffect(() => {
    if (recordingStatus === 'recording') {
      void requestScreenWakeLock();
      return;
    }

    void releaseScreenWakeLock();
  }, [recordingStatus]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && recordingStatusRef.current === 'recording') {
        void requestScreenWakeLock();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      void releaseScreenWakeLock();
    };
  }, []);

  useEffect(() => {
    if (!('geolocation' in navigator)) {
      return;
    }

    const watchId = navigator.geolocation.watchPosition(
      (position) => {
        const point = positionToPoint(position);
        setCurrentPosition(point);
        setGpsStatus(gpsStatusFromPoint(point));

        const activeTrip = currentTripRef.current;
        if (recordingStatusRef.current !== 'recording' || !activeTrip) {
          return;
        }

        if (!shouldSaveRoutePoint(activeTrip, point)) {
          return;
        }

        lastSavedPointAtRef.current = new Date(point.recordedAt).getTime();
        setCurrentTrip((trip) =>
          trip
            ? {
                ...trip,
                points: [...trip.points, point],
                updatedAt: point.recordedAt,
              }
            : trip,
        );
      },
      (error) => {
        setGpsStatus(getGeolocationErrorMessage(error));
      },
      {
        enableHighAccuracy: true,
        maximumAge: 5000,
        timeout: 15000,
      },
    );

    return () => navigator.geolocation.clearWatch(watchId);
  }, []);

  async function loadTrips() {
    try {
      setStorageError(null);
      setTrips(await storageAdapter.getAllTrips());
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : 'IndexedDB 저장소를 열지 못했습니다.');
    }
  }

  async function loadCheckpointPlaces() {
    try {
      setStorageError(null);
      setCheckpointPlaces(await storageAdapter.getAllCheckpointPlaces());
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : '체크포인트 이력을 열지 못했습니다.');
    }
  }

  async function loadAppSettings() {
    try {
      setStorageError(null);
      const storedSettings = await storageAdapter.getAppSettings();
      const permission = getInitialNotificationPermission();
      const nextSettings = storedSettings ?? createDefaultAppSettings();
      const effectiveSettings =
        nextSettings.pushNotificationsEnabled && permission !== 'granted'
          ? {
              ...nextSettings,
              pushNotificationsEnabled: false,
              updatedAt: new Date().toISOString(),
            }
          : nextSettings;
      setAppSettings(effectiveSettings);
      appSettingsRef.current = effectiveSettings;
      setNotificationPermission(permission);
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : '앱 설정을 열지 못했습니다.');
    }
  }

  function showNotice(message: string) {
    setNotice(message);
    window.setTimeout(() => setNotice(null), 3600);
  }

  function requestConfirmation(state: ConfirmState) {
    setConfirmState(state);
  }

  async function requestScreenWakeLock() {
    if (wakeLockRef.current && !wakeLockRef.current.released) {
      return;
    }

    const wakeLock = navigator.wakeLock;
    if (!wakeLock) {
      return;
    }

    try {
      const sentinel = await wakeLock.request('screen');
      wakeLockRef.current = sentinel;
      sentinel.addEventListener('release', () => {
        if (wakeLockRef.current === sentinel) {
          wakeLockRef.current = null;
        }
      });
    } catch {
      wakeLockRef.current = null;
    }
  }

  async function releaseScreenWakeLock() {
    const wakeLock = wakeLockRef.current;
    wakeLockRef.current = null;

    if (wakeLock && !wakeLock.released) {
      await wakeLock.release().catch(() => undefined);
    }
  }

  async function saveAppSettings(nextSettings: AppSettings) {
    await storageAdapter.saveAppSettings(nextSettings);
    setAppSettings(nextSettings);
    appSettingsRef.current = nextSettings;
  }

  async function setPushNotificationsEnabled(enabled: boolean) {
    const nextSettings: AppSettings = {
      ...appSettingsRef.current,
      pushNotificationsEnabled: false,
      updatedAt: new Date().toISOString(),
    };

    if (!enabled) {
      try {
        await saveAppSettings(nextSettings);
        showNotice('푸시 알림을 껐습니다.');
      } catch (error) {
        showNotice(error instanceof Error ? error.message : '알림 설정 저장에 실패했습니다.');
      }
      return;
    }

    if (!('Notification' in window)) {
      setNotificationPermission('unsupported');
      showNotice('이 브라우저는 알림을 지원하지 않습니다.');
      return;
    }

    const permission =
      Notification.permission === 'default'
        ? await Notification.requestPermission()
        : Notification.permission;
    setNotificationPermission(permission);

    if (permission !== 'granted') {
      try {
        await saveAppSettings(nextSettings);
      } catch {
        // Permission feedback is more actionable than a settings write failure here.
      }
      showNotice('브라우저 알림 권한이 허용되지 않았습니다.');
      return;
    }

    try {
      await saveAppSettings({
        ...nextSettings,
        pushNotificationsEnabled: true,
        updatedAt: new Date().toISOString(),
      });
      showNotice('체크포인트 푸시 알림을 켰습니다.');
    } catch (error) {
      showNotice(error instanceof Error ? error.message : '알림 설정 저장에 실패했습니다.');
    }
  }

  async function showCheckpointNotification(checkpoint: Checkpoint) {
    if (!appSettingsRef.current.pushNotificationsEnabled) {
      return;
    }

    if (!('Notification' in window) || Notification.permission !== 'granted') {
      return;
    }

    const title = '체크포인트 저장 완료';
    const body = `${checkpoint.name || '체크포인트'} · ${formatTime(checkpoint.recordedAt)}`;
    const icon = `${import.meta.env.BASE_URL}icons/icon.svg`;
    const options: NotificationOptions = {
      body,
      icon,
      badge: icon,
      tag: `lets-go-commute-checkpoint-${checkpoint.id}`,
    };

    if ('serviceWorker' in navigator) {
      const registration = await navigator.serviceWorker.ready.catch(() => null);
      if (registration) {
        await registration.showNotification(title, options).catch(() => undefined);
        return;
      }
    }

    new Notification(title, options);
  }

  function createActiveTripDraft(
    trip: TripRecord,
    status: DraftRecordingStatus,
    activePause: string | null,
    prompt: CheckpointPromptState | null,
    checkpointEditorVisible: boolean,
  ): ActiveTripDraft {
    return {
      key: 'activeTripDraft',
      trip,
      recordingStatus: status,
      activePauseStartedAt: activePause,
      checkpointPrompt: prompt,
      showCheckpointEditor: checkpointEditorVisible,
      view: getDraftView(status),
      savedAt: new Date().toISOString(),
      appVersion: APP_VERSION,
    };
  }

  async function saveActiveTripDraftImmediately(
    trip: TripRecord,
    prompt: CheckpointPromptState | null,
  ) {
    const status = recordingStatusRef.current;

    if (!isDraftRecordingStatus(status)) {
      return;
    }

    await storageAdapter.saveActiveTripDraft(
      createActiveTripDraft(
        trip,
        status,
        activePauseStartedAtRef.current,
        prompt,
        showCheckpointEditorRef.current,
      ),
    );
  }

  async function restoreActiveTripDraft() {
    try {
      const draft = await storageAdapter.getActiveTripDraft();

      if (!draft) {
        return;
      }

      const savedAtMs = new Date(draft.savedAt).getTime();
      const isStaleRecording =
        draft.recordingStatus === 'recording' &&
        Number.isFinite(savedAtMs) &&
        Date.now() - savedAtMs > DRAFT_STALE_PAUSE_MS;
      const restoredStatus: DraftRecordingStatus = isStaleRecording
        ? 'paused'
        : draft.recordingStatus;
      const restoredActivePauseStartedAt = isStaleRecording
        ? draft.savedAt
        : draft.activePauseStartedAt;
      const restoredTrip = {
        ...draft.trip,
        updatedAt: isStaleRecording ? new Date().toISOString() : draft.trip.updatedAt,
      };

      setCurrentTrip(restoredTrip);
      setRecordingStatus(restoredStatus);
      setActivePauseStartedAt(restoredActivePauseStartedAt);
      setCheckpointPrompt(draft.checkpointPrompt);
      setShowCheckpointEditor(draft.showCheckpointEditor);
      setMapCheckpointEditor(null);
      setView(getDraftView(restoredStatus));
      lastSavedPointAtRef.current = getLastPointSavedAt(restoredTrip);
      showNotice(
        isStaleRecording
          ? '중단된 기록을 복구하고 일시정지로 전환했습니다.'
          : '진행 중이던 기록을 복구했습니다.',
      );
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : '임시 기록 복구에 실패했습니다.');
    } finally {
      setDraftHydrated(true);
    }
  }

  function hasRecoverableTrip() {
    return Boolean(currentTrip && isDraftRecordingStatus(recordingStatus));
  }

  const openCurrentMapCheckpointEditor = useCallback((checkpointId: string) => {
    if (!currentTripRef.current) {
      return;
    }

    const editor = createMapCheckpointEditorState(
      'current',
      currentTripRef.current,
      checkpointId,
    );

    if (editor) {
      setCheckpointPrompt(null);
      setMapCheckpointEditor(editor);
    }
  }, []);

  const openSelectedMapCheckpointEditor = useCallback(
    (checkpointId: string) => {
      if (!selectedTrip) {
        return;
      }

      const editor = createMapCheckpointEditorState('saved', selectedTrip, checkpointId);

      if (editor) {
        setCheckpointPrompt(null);
        setMapCheckpointEditor(editor);
      }
    },
    [selectedTrip],
  );

  function guardedSetView(nextView: AppView) {
    if (nextView === view) {
      return;
    }

    if (!hasRecoverableTrip()) {
      setView(nextView);
      return;
    }

    requestConfirmation({
      title: '진행 중인 기록이 있습니다',
      description:
        '기록은 자동 보존되지만, 화면을 이동하면 기록 조작 버튼이 숨겨질 수 있습니다.',
      confirmLabel: '이동',
      onConfirm: () => {
        setConfirmState(null);
        setView(nextView);
      },
    });
  }

  function requestFreshPosition(): Promise<GpsPoint> {
    return new Promise((resolve, reject) => {
      if (!('geolocation' in navigator)) {
        reject(new Error('이 브라우저에서는 위치 정보를 사용할 수 없습니다.'));
        return;
      }

      setGpsStatus({
        label: '위치 확인 중',
        detail: '현재 위치를 다시 확인하고 있습니다.',
        tone: 'idle',
      });

      navigator.geolocation.getCurrentPosition(
        (position) => {
          const point = positionToPoint(position);
          setCurrentPosition(point);
          setGpsStatus(gpsStatusFromPoint(point));
          resolve(point);
        },
        (error) => {
          const status = getGeolocationErrorMessage(error);
          setGpsStatus(status);
          reject(new Error(status.detail));
        },
        {
          enableHighAccuracy: true,
          maximumAge: 2000,
          timeout: 15000,
        },
      );
    });
  }

  function confirmStart() {
    if (currentTrip && isDraftRecordingStatus(recordingStatus)) {
      setView(getDraftView(recordingStatus));
      showNotice('진행 중인 기록으로 돌아왔습니다.');
      return;
    }

    requestConfirmation({
      title: '출발할까요?',
      description: '지금 위치에서 기록을 시작합니다.',
      confirmLabel: '출발!',
      onConfirm: () => {
        void startRecording();
      },
    });
  }

  async function startRecording() {
    setConfirmState(null);

    try {
      const point = await requestFreshPosition();
      const trip = createTripFromStart(point);
      lastSavedPointAtRef.current = new Date(point.recordedAt).getTime();
      setCurrentTrip(trip);
      setActivePauseStartedAt(null);
      setCheckpointPrompt(null);
      setShowCheckpointEditor(false);
      setMapCheckpointEditor(null);
      setRecordingStatus('recording');
      setView('recording');
      showNotice('출발! GPS 기록을 시작했습니다.');
    } catch (error) {
      showNotice(error instanceof Error ? error.message : '출발 위치를 확인하지 못했습니다.');
    }
  }

  function confirmCheckpoint() {
    void addCheckpoint();
  }

  async function addCheckpoint() {
    setCheckpointPrompt(null);

    if (!currentTripRef.current) {
      return;
    }

    try {
      const point = await requestFreshPosition();
      const activeTrip = currentTripRef.current;

      if (!activeTrip) {
        return;
      }

      const previousCheckpoint = activeTrip.checkpoints.at(-1);

      if (!previousCheckpoint) {
        return;
      }

      const matchedPlace = findCheckpointPlaceMatch(point, checkpointPlacesRef.current);
      const checkpoint = createCheckpoint(
        point,
        activeTrip.checkpoints.length,
        matchedPlace?.place.type ?? null,
        matchedPlace?.place.name ?? `체크포인트 ${activeTrip.checkpoints.length + 1}`,
      );
      const segment = createSegmentFromCheckpoints(previousCheckpoint, checkpoint);
      const prompt: CheckpointPromptState = {
        checkpointId: checkpoint.id,
        segmentId: segment.id,
        name: checkpoint.name,
        type: checkpoint.type,
        transportMode: segment.transportMode,
        savePlace: true,
        matchedPlaceId: matchedPlace?.place.id ?? null,
        matchedPlaceDistanceMeters: matchedPlace?.distanceMeters ?? null,
      };
      const updatedTrip: TripRecord = {
        ...activeTrip,
        points: [...activeTrip.points, point],
        checkpoints: [...activeTrip.checkpoints, checkpoint],
        segments: [...activeTrip.segments, segment],
        updatedAt: point.recordedAt,
      };

      setCurrentTrip((trip) => {
        if (!trip || trip.id !== activeTrip.id) {
          return trip;
        }

        return updatedTrip;
      });
      currentTripRef.current = updatedTrip;
      setCheckpointPrompt(prompt);
      lastSavedPointAtRef.current = new Date(point.recordedAt).getTime();
      try {
        await saveActiveTripDraftImmediately(updatedTrip, prompt);
        showNotice('체크포인트 자동 저장 완료! 방금 구간을 바로 정리할 수 있습니다.');
      } catch (error) {
        showNotice(
          error instanceof Error
            ? `체크포인트 기록됨, 임시 저장 실패: ${error.message}`
            : '체크포인트 기록됨, 임시 저장에 실패했습니다.',
        );
      }
      void showCheckpointNotification(checkpoint);
    } catch (error) {
      showNotice(error instanceof Error ? error.message : '체크포인트 위치를 확인하지 못했습니다.');
    }
  }

  function updateCheckpointPrompt(patch: Partial<CheckpointPromptState>) {
    setCheckpointPrompt((prompt) => (prompt ? { ...prompt, ...patch } : prompt));
  }

  async function saveCheckpointPlaceFromPrompt(
    prompt: CheckpointPromptState,
    checkpoint: Checkpoint,
  ) {
    const name = prompt.name.trim();

    if (name.length === 0) {
      return;
    }

    const existingPlace = prompt.matchedPlaceId
      ? checkpointPlacesRef.current.find((place) => place.id === prompt.matchedPlaceId)
      : null;
    const nowIso = new Date().toISOString();
    const place: SavedCheckpointPlace = {
      id: existingPlace?.id ?? generateId(),
      name,
      type: prompt.type,
      lat: checkpoint.lat,
      lng: checkpoint.lng,
      accuracy: checkpoint.accuracy,
      createdAt: existingPlace?.createdAt ?? nowIso,
      updatedAt: nowIso,
      lastUsedAt: nowIso,
      usedCount: (existingPlace?.usedCount ?? 0) + 1,
    };

    await storageAdapter.saveCheckpointPlace(place);
    setCheckpointPlaces((places) =>
      [place, ...places.filter((item) => item.id !== place.id)].sort((a, b) =>
        b.lastUsedAt.localeCompare(a.lastUsedAt),
      ),
    );
  }

  async function saveCheckpointPrompt() {
    if (!checkpointPrompt) {
      return;
    }

    const prompt = checkpointPrompt;
    const checkpoint = currentTripRef.current?.checkpoints.find(
      (item) => item.id === prompt.checkpointId,
    );

    updateCheckpoint(checkpointPrompt.checkpointId, {
      name: checkpointPrompt.name,
      type: checkpointPrompt.type,
    });
    updateSegment(checkpointPrompt.segmentId, {
      transportMode: checkpointPrompt.transportMode,
    });

    try {
      if (prompt.savePlace && checkpoint) {
        await saveCheckpointPlaceFromPrompt(prompt, checkpoint);
      }

      setCheckpointPrompt(null);
      showNotice(prompt.savePlace ? '체크포인트 정보와 장소 이력을 저장했습니다.' : '체크포인트 정보를 저장했습니다.');
    } catch (error) {
      setCheckpointPrompt(null);
      showNotice(error instanceof Error ? error.message : '장소 이력 저장에 실패했습니다.');
    }
  }

  function skipCheckpointPrompt() {
    setCheckpointPrompt(null);
    showNotice('나중에 편집할 수 있도록 남겨뒀습니다.');
  }

  function confirmPause() {
    requestConfirmation({
      title: '일시정지할까요?',
      description: '총 경과 시간은 계속 흐르고, 이동 경로 저장만 멈춥니다.',
      confirmLabel: '일시정지',
      onConfirm: pauseRecording,
    });
  }

  function pauseRecording() {
    setConfirmState(null);
    const startedAt = new Date().toISOString();
    setActivePauseStartedAt(startedAt);
    setRecordingStatus('paused');
    setCurrentTrip((trip) => (trip ? { ...trip, updatedAt: startedAt } : trip));
    showNotice('일시정지 중입니다. 현재 위치 표시는 계속 갱신됩니다.');
  }

  function resumeRecording() {
    const pauseStartedAt = activePauseStartedAtRef.current;
    if (!pauseStartedAt) {
      setRecordingStatus('recording');
      return;
    }

    const endedAt = new Date().toISOString();
    const pauseRange: PauseRange = {
      startedAt: pauseStartedAt,
      endedAt,
      durationMs: calculateTotalDuration(pauseStartedAt, endedAt),
    };

    setCurrentTrip((trip) =>
      trip
        ? {
            ...trip,
            pauseRanges: [...trip.pauseRanges, pauseRange],
            pausedDurationMs: calculatePausedDuration([...trip.pauseRanges, pauseRange]),
            updatedAt: endedAt,
          }
        : trip,
    );
    setActivePauseStartedAt(null);
    setRecordingStatus('recording');
    lastSavedPointAtRef.current = Date.now();
    showNotice('재개! 다시 이동 경로를 기록합니다.');
  }

  function confirmFinish() {
    requestConfirmation({
      title: '도착 처리할까요?',
      description: '기록이 종료되고 요약 화면으로 이동합니다.',
      confirmLabel: '도착!',
      onConfirm: () => {
        void finishRecording();
      },
    });
  }

  async function finishRecording() {
    setConfirmState(null);

    const trip = currentTripRef.current;
    if (!trip) {
      return;
    }

    try {
      const freshPoint = await requestFreshPosition().catch(() => null);
      const endedAt = new Date().toISOString();
      const point = freshPoint
        ? { ...freshPoint, recordedAt: endedAt }
        : currentPosition
          ? { ...currentPosition, recordedAt: endedAt }
          : null;

      if (!point) {
        showNotice('현재 위치를 가져오지 못했습니다. 잠시 후 다시 시도해주세요.');
        return;
      }

      const pauseRanges = [...trip.pauseRanges];
      const activePause = activePauseStartedAtRef.current;
      if (activePause) {
        pauseRanges.push({
          startedAt: activePause,
          endedAt,
          durationMs: calculateTotalDuration(activePause, endedAt),
        });
      }

      const endCheckpoint = createCheckpoint(point, trip.checkpoints.length, 'end', '도착지');
      const checkpoints = [...trip.checkpoints, endCheckpoint];
      const segments = buildSegmentsFromCheckpoints(checkpoints, trip.segments);
      const pausedDurationMs = calculatePausedDuration(pauseRanges);
      const totalDurationMs = calculateTotalDuration(trip.startedAt, endedAt);
      const finishedTrip: TripRecord = {
        ...trip,
        endedAt,
        totalDurationMs,
        pausedDurationMs,
        pauseRanges,
        checkpoints,
        points: [...trip.points, point],
        segments,
        updatedAt: endedAt,
      };

      setCurrentTrip(finishedTrip);
      setActivePauseStartedAt(null);
      setCheckpointPrompt(null);
      setMapCheckpointEditor(null);
      setRecordingStatus('finished');
      setView('summary');
      showNotice('도착! 요약을 확인해주세요.');
    } catch (error) {
      showNotice(error instanceof Error ? error.message : '기록 종료 중 문제가 발생했습니다.');
    }
  }

  function confirmDiscardCurrent() {
    requestConfirmation({
      title: '정말 삭제할까요?',
      description: '현재 임시 기록은 저장되지 않고 사라집니다.',
      confirmLabel: '삭제',
      tone: 'danger',
      onConfirm: () => {
        void storageAdapter.clearActiveTripDraft().catch((error) => {
          setStorageError(error instanceof Error ? error.message : '임시 기록 삭제에 실패했습니다.');
        });
        setConfirmState(null);
        setCurrentTrip(null);
        setActivePauseStartedAt(null);
        setCheckpointPrompt(null);
        setShowCheckpointEditor(false);
        setMapCheckpointEditor(null);
        setRecordingStatus('idle');
        setView('home');
        showNotice('임시 기록을 삭제했습니다.');
      },
    });
  }

  function updateCheckpoint(
    checkpointId: string,
    patch: Partial<Pick<Checkpoint, 'name' | 'type' | 'memo'>>,
  ) {
    setCurrentTrip((trip) =>
      trip
        ? {
            ...trip,
            checkpoints: trip.checkpoints.map((checkpoint) =>
              checkpoint.id === checkpointId ? { ...checkpoint, ...patch } : checkpoint,
            ),
            updatedAt: new Date().toISOString(),
          }
        : trip,
    );
  }

  function updateSegment(
    segmentId: string,
    patch: Partial<Pick<Segment, 'transportMode' | 'memo'>>,
  ) {
    setCurrentTrip((trip) =>
      trip
        ? {
            ...trip,
            segments: trip.segments.map((segment) =>
              segment.id === segmentId ? { ...segment, ...patch } : segment,
            ),
            updatedAt: new Date().toISOString(),
          }
        : trip,
    );
  }

  function updateMapCheckpointEditorDraft(
    patch: Partial<Pick<MapCheckpointEditorState, 'memo' | 'name' | 'transportMode' | 'type'>>,
  ) {
    setMapCheckpointEditor((editor) => (editor ? { ...editor, ...patch } : editor));
  }

  async function saveMapCheckpointEditor() {
    if (!mapCheckpointEditor) {
      return;
    }

    const editor = mapCheckpointEditor;

    if (editor.source === 'current') {
      setCurrentTrip((trip) => (trip ? applyMapCheckpointEditorToTrip(trip, editor) : trip));
      setMapCheckpointEditor(null);
      showNotice('체크포인트를 저장했습니다.');
      return;
    }

    const tripToEdit = trips.find((trip) => trip.id === editor.tripId);
    if (!tripToEdit) {
      setMapCheckpointEditor(null);
      return;
    }

    const updatedTrip = applyMapCheckpointEditorToTrip(tripToEdit, editor);

    try {
      await storageAdapter.saveTrip(updatedTrip);
      setTrips((previous) =>
        previous.map((trip) => (trip.id === updatedTrip.id ? updatedTrip : trip)),
      );
      setMapCheckpointEditor(null);
      showNotice('체크포인트를 저장했습니다.');
    } catch (error) {
      showNotice(error instanceof Error ? error.message : '체크포인트 저장에 실패했습니다.');
    }
  }

  function getCheckpointStructureActionLabel(
    mode: 'delete' | 'merge-previous' | 'merge-next',
  ) {
    if (mode === 'merge-previous') {
      return '이전 체크포인트와 병합';
    }

    if (mode === 'merge-next') {
      return '다음 체크포인트와 병합';
    }

    return '체크포인트 삭제';
  }

  function confirmCheckpointStructureEdit(
    source: MapCheckpointEditorState['source'],
    tripId: string,
    checkpointId: string,
    mode: 'delete' | 'merge-previous' | 'merge-next',
  ) {
    const trip =
      source === 'current'
        ? currentTripRef.current
        : trips.find((item) => item.id === tripId) ?? null;
    const checkpoint = trip?.checkpoints.find((item) => item.id === checkpointId);

    if (!trip || !checkpoint) {
      return;
    }

    if (!canRemoveCheckpoint(trip, checkpointId)) {
      showNotice('출발지와 도착지는 삭제하거나 병합할 수 없습니다.');
      return;
    }

    requestConfirmation({
      title: getCheckpointStructureActionLabel(mode),
      description:
        mode === 'delete'
          ? `${checkpoint.name || '이 체크포인트'}를 삭제하고 구간을 다시 계산합니다.`
          : `${checkpoint.name || '이 체크포인트'}를 합치고 구간을 다시 계산합니다.`,
      confirmLabel: mode === 'delete' ? '삭제' : '병합',
      tone: mode === 'delete' ? 'danger' : 'primary',
      onConfirm: () => {
        void applyCheckpointStructureEdit(source, tripId, checkpointId, mode);
      },
    });
  }

  async function applyCheckpointStructureEdit(
    source: MapCheckpointEditorState['source'],
    tripId: string,
    checkpointId: string,
    mode: 'delete' | 'merge-previous' | 'merge-next',
  ) {
    setConfirmState(null);

    const trip =
      source === 'current'
        ? currentTripRef.current
        : trips.find((item) => item.id === tripId) ?? null;
    const checkpoint = trip?.checkpoints.find((item) => item.id === checkpointId);

    if (!trip || !checkpoint) {
      return;
    }

    const updatedTrip = removeCheckpointFromTrip(trip, checkpointId, mode);

    if (!updatedTrip) {
      showNotice('이 체크포인트는 삭제하거나 병합할 수 없습니다.');
      return;
    }

    if (source === 'current') {
      const nextPrompt =
        checkpointPromptRef.current?.checkpointId === checkpointId
          ? null
          : checkpointPromptRef.current;

      setCurrentTrip(updatedTrip);
      currentTripRef.current = updatedTrip;
      setCheckpointPrompt(nextPrompt);
      setMapCheckpointEditor((editor) =>
        editor?.checkpointId === checkpointId ? null : editor,
      );

      try {
        await saveActiveTripDraftImmediately(updatedTrip, nextPrompt);
      } catch (error) {
        setStorageError(error instanceof Error ? error.message : '임시 기록 저장에 실패했습니다.');
      }

      showNotice(
        mode === 'delete'
          ? '체크포인트를 삭제했습니다.'
          : '체크포인트를 병합했습니다.',
      );
      return;
    }

    try {
      await storageAdapter.saveTrip(updatedTrip);
      setTrips((previous) =>
        previous.map((item) => (item.id === updatedTrip.id ? updatedTrip : item)),
      );
      setMapCheckpointEditor((editor) =>
        editor?.checkpointId === checkpointId ? null : editor,
      );
      showNotice(
        mode === 'delete'
          ? '체크포인트를 삭제했습니다.'
          : '체크포인트를 병합했습니다.',
      );
    } catch (error) {
      showNotice(error instanceof Error ? error.message : '체크포인트 변경 저장에 실패했습니다.');
    }
  }

  async function saveCurrentTrip() {
    if (!currentTrip) {
      return;
    }

    const result = validateTripBeforeSave(currentTrip);
    if (!result.valid) {
      showNotice('저장 조건을 확인해주세요.');
      return;
    }

    const tripToSave = {
      ...currentTrip,
      updatedAt: new Date().toISOString(),
    };

    try {
      await storageAdapter.saveTrip(tripToSave);
      await storageAdapter.clearActiveTripDraft();
      await loadTrips();
      setCurrentTrip(tripToSave);
      setSelectedTripId(tripToSave.id);
      setCheckpointPrompt(null);
      setShowCheckpointEditor(false);
      setMapCheckpointEditor(null);
      setRecordingStatus('saved');
      setView('detail');
      showNotice('구간 기록 저장 완료!');
    } catch (error) {
      showNotice(error instanceof Error ? error.message : 'IndexedDB 저장에 실패했습니다.');
    }
  }

  function openTripDetail(tripId: string) {
    setSelectedTripId(tripId);
    setComparisonTargetId(null);
    setMapCheckpointEditor(null);
    setView('detail');
  }

  function confirmDeleteTrip(tripId: string) {
    requestConfirmation({
      title: '정말 삭제할까요?',
      description: '삭제한 기록은 복구할 수 없습니다.',
      confirmLabel: '삭제',
      tone: 'danger',
      onConfirm: () => {
        void deleteTrip(tripId);
      },
    });
  }

  async function deleteTrip(tripId: string) {
    setConfirmState(null);

    try {
      await storageAdapter.deleteTrip(tripId);
      setTrips((previous) => previous.filter((trip) => trip.id !== tripId));
      setMapCheckpointEditor(null);
      if (selectedTripId === tripId) {
        setSelectedTripId(null);
        setComparisonTargetId(null);
        setView('records');
      }
      showNotice('기록을 삭제했습니다.');
    } catch (error) {
      showNotice(error instanceof Error ? error.message : '기록 삭제에 실패했습니다.');
    }
  }

  function confirmClearAllTrips() {
    requestConfirmation({
      title: '전체 데이터를 삭제할까요?',
      description: '저장된 모든 이동 기록이 삭제되며 복구할 수 없습니다.',
      confirmLabel: '전체 삭제',
      tone: 'danger',
      onConfirm: () => {
        void clearAllTrips();
      },
    });
  }

  async function clearAllTrips() {
    setConfirmState(null);

    try {
      await storageAdapter.clearAllTrips();
      await storageAdapter.clearCheckpointPlaces();
      await storageAdapter.clearActiveTripDraft();
      setTrips([]);
      setCheckpointPlaces([]);
      setSelectedTripId(null);
      setComparisonTargetId(null);
      setMapCheckpointEditor(null);
      showNotice('전체 데이터를 삭제했습니다.');
      setView('home');
    } catch (error) {
      showNotice(error instanceof Error ? error.message : '전체 데이터 삭제에 실패했습니다.');
    }
  }

  const renderContent = () => {
    if (view === 'recording') {
      return renderRecording();
    }

    if (view === 'summary') {
      return renderSummary();
    }

    if (view === 'edit') {
      return renderEdit();
    }

    if (view === 'records') {
      return renderRecords();
    }

    if (view === 'detail') {
      return renderDetail();
    }

    if (view === 'compare') {
      return renderCompare();
    }

    if (view === 'settings') {
      return renderSettings();
    }

    return renderHome();
  };

  const liveTotalDuration = getLiveTotalDuration(currentTrip, now);
  const livePausedDuration = getLivePausedDuration(currentTrip, activePauseStartedAt, now);
  const liveRecordedDuration = Math.max(0, liveTotalDuration - livePausedDuration);
  const lastCheckpoint = currentTrip?.checkpoints.at(-1);
  const liveSegmentDuration = lastCheckpoint
    ? Math.max(0, now - new Date(lastCheckpoint.recordedAt).getTime())
    : 0;

  function renderHome() {
    return (
      <section className="screen-grid home-screen">
        <div className="hero-copy">
          <span className="pill loud">출근드림팀</span>
          <h1>출발 버튼 하나로 오늘의 이동 기록을 찍어두세요.</h1>
          <p>
            체크포인트를 통과하고, 도착 후 이동수단과 이름을 정리해서 내 기록과 한판
            비교합니다.
          </p>
          <div className="hero-actions">
            <button className="start-button" onClick={confirmStart} type="button">
              <Play aria-hidden="true" />
              출발!
            </button>
          </div>
        </div>

        <div className="map-stage">
          <MapView
            currentPosition={currentPosition}
            height="420px"
            points={[]}
            savedPlaces={checkpointPlaces}
            viewKey="home"
          />
        </div>

        <div className="status-strip">
          {renderGpsStatus()}
          <div>
            <Trophy aria-hidden="true" />
            <strong>{trips.length}개 기록 저장됨</strong>
            <span>IndexedDB 로컬 저장</span>
          </div>
          <div>
            <ShieldAlert aria-hidden="true" />
            <strong>백그라운드 GPS 제한</strong>
            <span>앱이 백그라운드로 가면 기록이 중단될 수 있습니다.</span>
          </div>
        </div>
      </section>
    );
  }

  function renderRecording() {
    if (!currentTrip) {
      return renderMissingTrip();
    }

    return (
      <section className="recording-screen">
        <div className={`recording-banner ${recordingStatus}`}>
          <span>{recordingStatus === 'paused' ? '일시정지 중' : '기록 중'}</span>
          <strong>{recordingStatus === 'paused' ? '잠깐 멈춤!' : '체크포인트를 노려보세요'}</strong>
        </div>
        <MapView
          checkpoints={currentTrip.checkpoints}
          currentPosition={currentPosition}
          onCheckpointSelect={openCurrentMapCheckpointEditor}
          segments={currentTrip.segments}
          points={currentTrip.points}
          savedPlaces={checkpointPlaces}
          height="430px"
          viewKey={`recording-${currentTrip.id}`}
        />
        <div className={`bottom-controls ${recordingStatus === 'paused' ? 'paused' : ''}`}>
          {recordingStatus === 'paused' ? (
            <button className="primary-button" onClick={resumeRecording} type="button">
              <RotateCcw aria-hidden="true" />
              재개
            </button>
          ) : (
            <>
              <button className="primary-button" onClick={confirmCheckpoint} type="button">
                <Check aria-hidden="true" />
                체크!
              </button>
              <button className="secondary-button" onClick={confirmPause} type="button">
                <Pause aria-hidden="true" />
                일시정지
              </button>
            </>
          )}
          <button className="finish-button" onClick={confirmFinish} type="button">
            <Square aria-hidden="true" />
            도착!
          </button>
        </div>
        <TimerDisplay
          pausedDurationMs={livePausedDuration}
          segmentDurationMs={liveSegmentDuration}
          totalDurationMs={liveTotalDuration}
        />
        <div className="recording-metrics">
          <Metric label="기록된 이동 시간" value={formatDuration(liveRecordedDuration)} />
          <Metric label="체크포인트 수" value={`${currentTrip.checkpoints.length}개`} />
          <Metric label="GPS 포인트" value={`${currentTrip.points.length}개`} />
        </div>
        {renderCheckpointManager(currentTrip, 'current', '이동 중 체크포인트')}
        {renderGpsStatus()}
      </section>
    );
  }

  function renderSummary() {
    if (!currentTrip) {
      return renderMissingTrip();
    }

    return (
      <section className="detail-layout">
        <div className="section-title">
          <span className="pill loud">도착!</span>
          <h1>오늘의 기록 요약</h1>
        </div>
        <MapView
          checkpoints={currentTrip.checkpoints}
          onCheckpointSelect={openCurrentMapCheckpointEditor}
          points={currentTrip.points}
          savedPlaces={checkpointPlaces}
          segments={currentTrip.segments}
          viewKey={`summary-${currentTrip.id}`}
        />
        <StatsGrid trip={currentTrip} />
        <section className="panel">
          <h2>구간별 소요 시간</h2>
          <SegmentSummary checkpoints={currentTrip.checkpoints} segments={currentTrip.segments} />
        </section>
        {renderCheckpointManager(currentTrip, 'current', '체크포인트 관리')}
        <div className="button-row">
          <button
            className="primary-button"
            onClick={() => {
              setRecordingStatus('editing');
              setShowCheckpointEditor(false);
              setView('edit');
            }}
            type="button"
          >
            <Pencil aria-hidden="true" />
            편집하기
          </button>
          <button className="danger-button subtle" onClick={confirmDiscardCurrent} type="button">
            <Trash2 aria-hidden="true" />
            삭제
          </button>
        </div>
      </section>
    );
  }

  function renderEdit() {
    if (!currentTrip) {
      return renderMissingTrip();
    }

    return (
      <section className="detail-layout">
        <div className="section-title">
          <span className="pill loud">구간 기록 갱신</span>
          <h1>구간별 이동수단 입력</h1>
        </div>

        <section className="panel form-panel">
          <h2>구간별 이동수단</h2>
          <div className="editor-list">
            {currentTrip.segments.map((segment, index) => (
              <article className="editor-item compact" key={segment.id}>
                <div className="editor-heading">
                  <span className="number-badge">{index + 1}</span>
                  <strong>{getSegmentLabel(segment, currentTrip.checkpoints)}</strong>
                </div>
                <p className="muted">{formatDuration(segment.durationMs)}</p>
                <label htmlFor={`segment-mode-${segment.id}`}>
                  이동수단
                  <TransportModeSelect
                    id={`segment-mode-${segment.id}`}
                    onChange={(transportMode) => updateSegment(segment.id, { transportMode })}
                    value={segment.transportMode}
                  />
                </label>
              </article>
            ))}
          </div>
        </section>

        <div className="button-row editor-tools">
          <button
            className="secondary-button"
            onClick={() => setShowCheckpointEditor((visible) => !visible)}
            type="button"
          >
            <Pencil aria-hidden="true" />
            {showCheckpointEditor ? '체크포인트 접기' : '체크포인트 편집'}
          </button>
        </div>

        {showCheckpointEditor ? (
          renderCheckpointManager(currentTrip, 'current', '체크포인트 편집')
        ) : null}

        {!validation.valid ? (
          <section className="validation-box" role="alert">
            <AlertCircle aria-hidden="true" />
            <div>
              <strong>저장 전 확인</strong>
              <ul>
                {validation.errors.map((error) => (
                  <li key={error}>{error}</li>
                ))}
              </ul>
            </div>
          </section>
        ) : null}

        <div className="button-row sticky-save">
          <button
            className="primary-button"
            disabled={!validation.valid}
            onClick={() => {
              void saveCurrentTrip();
            }}
            type="button"
          >
            <Save aria-hidden="true" />
            저장
          </button>
          <button className="secondary-button" onClick={() => setView('summary')} type="button">
            요약으로
          </button>
        </div>
      </section>
    );
  }

  function renderCheckpointManager(
    trip: TripRecord,
    source: MapCheckpointEditorState['source'],
    title: string,
  ) {
    return (
      <section className="panel checkpoint-manager">
        <h2>{title}</h2>
        <ol className="checkpoint-list checkpoint-edit-list">
          {trip.checkpoints.map((checkpoint, index) => {
            const isFixedEndpoint = isFixedEndpointCheckpoint(trip, index);
            const canMergePrevious = canRemoveCheckpoint(trip, checkpoint.id) && index > 0;
            const canMergeNext =
              canRemoveCheckpoint(trip, checkpoint.id) && index < trip.checkpoints.length - 1;

            return (
              <li className="checkpoint-edit-row" key={checkpoint.id}>
                <span className="number-badge">{checkpoint.order + 1}</span>
                <div className="checkpoint-edit-body">
                  <div>
                    <strong>{checkpoint.name || `체크포인트 ${index + 1}`}</strong>
                    <span>
                      {checkpoint.type ? checkpointTypeLabels[checkpoint.type] : '유형 없음'} ·{' '}
                      {formatTime(checkpoint.recordedAt)}
                    </span>
                    {checkpoint.memo ? <p>{checkpoint.memo}</p> : null}
                  </div>
                </div>
                <div className="checkpoint-action-column">
                  <button
                    aria-label="체크포인트 편집"
                    className="checkpoint-icon-button"
                    onClick={() =>
                      source === 'current'
                        ? openCurrentMapCheckpointEditor(checkpoint.id)
                        : openSelectedMapCheckpointEditor(checkpoint.id)
                    }
                    title="편집"
                    type="button"
                  >
                    <Pencil aria-hidden="true" />
                  </button>
                  {!isFixedEndpoint ? (
                    <button
                      aria-label="체크포인트 삭제"
                      className="checkpoint-icon-button danger"
                      onClick={() =>
                        confirmCheckpointStructureEdit(
                          source,
                          trip.id,
                          checkpoint.id,
                          'delete',
                        )
                      }
                      title="삭제"
                      type="button"
                    >
                      <Trash2 aria-hidden="true" />
                    </button>
                  ) : null}
                  {canMergePrevious ? (
                    <button
                      aria-label="이전 체크포인트와 병합"
                      className="checkpoint-icon-button merge-previous"
                      onClick={() =>
                        confirmCheckpointStructureEdit(
                          source,
                          trip.id,
                          checkpoint.id,
                          'merge-previous',
                        )
                      }
                      title="이전과 병합"
                      type="button"
                    >
                      <GitMerge aria-hidden="true" />
                    </button>
                  ) : null}
                  {canMergeNext ? (
                    <button
                      aria-label="다음 체크포인트와 병합"
                      className="checkpoint-icon-button merge-next"
                      onClick={() =>
                        confirmCheckpointStructureEdit(
                          source,
                          trip.id,
                          checkpoint.id,
                          'merge-next',
                        )
                      }
                      title="다음과 병합"
                      type="button"
                    >
                      <GitMerge aria-hidden="true" />
                    </button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ol>
      </section>
    );
  }

  function renderRecords() {
    return (
      <section className="detail-layout">
        <div className="section-title">
          <span className="pill loud">내 기록</span>
          <h1>저장된 이동 기록</h1>
        </div>
        {trips.length === 0 ? (
          <EmptyState
            actionLabel="첫 기록 시작"
            icon={<MapPin aria-hidden="true" />}
            message="아직 저장된 기록이 없습니다."
            onAction={confirmStart}
          />
        ) : (
          <div className="trip-list">
            {trips.map((trip) => (
              <TripCard
                key={trip.id}
                onDelete={confirmDeleteTrip}
                onOpen={openTripDetail}
                trip={trip}
              />
            ))}
          </div>
        )}
      </section>
    );
  }

  function renderDetail() {
    if (!selectedTrip) {
      return (
        <EmptyState
          actionLabel="기록 목록"
          icon={<AlertCircle aria-hidden="true" />}
          message="선택한 기록을 찾을 수 없습니다."
          onAction={() => setView('records')}
        />
      );
    }

    return (
      <section className="detail-layout">
        <div className="section-title">
          <span className="pill loud">상세 보기</span>
          <h1>{selectedTrip.name}</h1>
          <p>{formatDate(selectedTrip.startedAt)}</p>
        </div>
        <MapView
          checkpoints={selectedTrip.checkpoints}
          onCheckpointSelect={openSelectedMapCheckpointEditor}
          points={selectedTrip.points}
          savedPlaces={checkpointPlaces}
          segments={selectedTrip.segments}
          viewKey={`detail-${selectedTrip.id}`}
        />
        <StatsGrid trip={selectedTrip} />
        {renderCheckpointManager(selectedTrip, 'saved', '체크포인트 목록')}
        <section className="panel">
          <h2>구간 기록</h2>
          <SegmentSummary checkpoints={selectedTrip.checkpoints} segments={selectedTrip.segments} />
        </section>
        {selectedTrip.memo ? (
          <section className="panel">
            <h2>메모</h2>
            <p>{selectedTrip.memo}</p>
          </section>
        ) : null}
        <div className="button-row">
          <button
            className="primary-button"
            onClick={() => {
              setComparisonTargetId(null);
              setView('compare');
            }}
            type="button"
          >
            <GitCompareArrows aria-hidden="true" />
            비교
          </button>
          <button
            className="danger-button subtle"
            onClick={() => confirmDeleteTrip(selectedTrip.id)}
            type="button"
          >
            <Trash2 aria-hidden="true" />
            삭제
          </button>
        </div>
      </section>
    );
  }

  function renderCompare() {
    if (!selectedTrip) {
      return renderDetail();
    }

    const candidates = findSimilarTrips(selectedTrip, trips);
    const target =
      candidates.find((trip) => trip.id === comparisonTargetId) ?? candidates[0] ?? null;
    const segmentCountDifferent = target
      ? selectedTrip.segments.length !== target.segments.length
      : false;

    return (
      <section className="detail-layout">
        <div className="section-title">
          <span className="pill loud">내 기록과 한판 비교</span>
          <h1>{selectedTrip.name}</h1>
        </div>
        {candidates.length === 0 ? (
          <EmptyState
            actionLabel="상세로"
            icon={<GitCompareArrows aria-hidden="true" />}
            message="비교할 수 있는 비슷한 출발지/도착지 기록이 아직 없습니다."
            onAction={() => setView('detail')}
          />
        ) : (
          <>
            <section className="panel form-panel">
              <label>
                추천 기록
                <select
                  onChange={(event) => setComparisonTargetId(event.target.value)}
                  value={target?.id ?? ''}
                >
                  {candidates.map((trip) => (
                    <option key={trip.id} value={trip.id}>
                      {trip.name} · {formatDateTime(trip.startedAt)}
                    </option>
                  ))}
                </select>
              </label>
            </section>
            {target ? (
              <>
                <MapView
                  checkpoints={selectedTrip.checkpoints}
                  comparePoints={target.points}
                  onCheckpointSelect={openSelectedMapCheckpointEditor}
                  points={selectedTrip.points}
                  savedPlaces={checkpointPlaces}
                  segments={selectedTrip.segments}
                  viewKey={`compare-${selectedTrip.id}-${target.id}`}
                />
                {segmentCountDifferent ? (
                  <section className="warning-box">
                    <AlertCircle aria-hidden="true" />
                    <strong>구간 구조가 다릅니다</strong>
                    <span>구간별 비교는 순서 기준으로 가능한 범위까지만 표시합니다.</span>
                  </section>
                ) : null}
                <section className="compare-grid">
                  <CompareMetric
                    base={selectedTrip.totalDurationMs}
                    label="총 소요 시간 차이"
                    target={target.totalDurationMs}
                  />
                  <CompareMetric
                    base={selectedTrip.pausedDurationMs}
                    label="일시정지 시간 차이"
                    target={target.pausedDurationMs}
                  />
                  <CompareMetric
                    base={selectedTrip.totalDurationMs - selectedTrip.pausedDurationMs}
                    label="기록된 이동 시간 차이"
                    target={target.totalDurationMs - target.pausedDurationMs}
                  />
                  <CompareCountMetric
                    base={selectedTrip.checkpoints.length}
                    label="체크포인트 수 차이"
                    target={target.checkpoints.length}
                  />
                </section>
                <section className="panel">
                  <h2>구간별 비교</h2>
                  <div className="segment-compare-list">
                    {Array.from({
                      length: Math.max(selectedTrip.segments.length, target.segments.length),
                    }).map((_, index) => {
                      const baseSegment = selectedTrip.segments[index];
                      const targetSegment = target.segments[index];

                      return (
                        <article className="segment-compare" key={`${index}-${target.id}`}>
                          <span className="number-badge">{index + 1}</span>
                          <div>
                            <strong>구간 {index + 1}</strong>
                            {baseSegment && targetSegment ? (
                              <>
                                <span>
                                  시간 차이:{' '}
                                  {formatDelta(targetSegment.durationMs - baseSegment.durationMs)}
                                </span>
                                <span>
                                  이동수단:{' '}
                                  {baseSegment.transportMode
                                    ? transportModeLabels[baseSegment.transportMode]
                                    : '미지정'}{' '}
                                  vs{' '}
                                  {targetSegment.transportMode
                                    ? transportModeLabels[targetSegment.transportMode]
                                    : '미지정'}
                                </span>
                              </>
                            ) : (
                              <span>대응 구간 없음</span>
                            )}
                          </div>
                        </article>
                      );
                    })}
                  </div>
                </section>
              </>
            ) : null}
          </>
        )}
      </section>
    );
  }

  function renderSettings() {
    return (
      <section className="detail-layout">
        <div className="section-title">
          <span className="pill loud">설정</span>
          <h1>앱 정보</h1>
        </div>
        <section className="panel info-panel">
          <Info aria-hidden="true" />
          <div>
            <h2>출근드림팀</h2>
            <p>GPS 기반 이동 기록 챌린지 · v{APP_VERSION}</p>
          </div>
        </section>
        <section className="settings-grid">
          <Metric label="저장된 기록 수" value={`${trips.length}개`} />
          <Metric label="저장 방식" value="IndexedDB 로컬 저장" />
          <Metric label="알림 권한" value={getNotificationPermissionLabel(notificationPermission)} />
        </section>
        <section className="panel settings-panel">
          <h2>푸시 알림</h2>
          <label className="setting-toggle">
            <input
              checked={appSettings.pushNotificationsEnabled}
              disabled={notificationPermission === 'unsupported'}
              onChange={(event) => {
                void setPushNotificationsEnabled(event.target.checked);
              }}
              type="checkbox"
            />
            <span>
              {appSettings.pushNotificationsEnabled ? (
                <Bell aria-hidden="true" />
              ) : (
                <BellOff aria-hidden="true" />
              )}
              <strong>체크포인트 알림</strong>
              <small>
                {appSettings.pushNotificationsEnabled
                  ? '체크포인트 저장 시 알림을 보냅니다.'
                  : '체크포인트 알림이 꺼져 있습니다.'}
              </small>
            </span>
          </label>
        </section>
        <section className="panel">
          <h2>위치 권한 안내</h2>
          <p>
            위치 권한이 필요합니다. 브라우저 설정에서 위치 권한을 허용해야 출발, 체크,
            도착 위치를 기록할 수 있습니다.
          </p>
        </section>
        <section className="panel">
          <h2>Known Limitations</h2>
          <ul className="plain-list">
            <li>1차 MVP는 로컬 저장만 지원합니다.</li>
            <li>브라우저 또는 기기를 바꾸면 기록이 공유되지 않습니다.</li>
            <li>앱을 삭제하거나 브라우저 데이터를 삭제하면 기록이 사라질 수 있습니다.</li>
            <li>백그라운드 GPS 기록은 보장하지 않습니다.</li>
            <li>GPS 정확도는 기기와 환경에 따라 달라집니다.</li>
            <li>OpenStreetMap 공용 타일은 대량 트래픽 서비스용이 아닙니다.</li>
            <li>자차와 택시는 이동수단으로 제공하지 않습니다.</li>
          </ul>
        </section>
        <button className="danger-button" onClick={confirmClearAllTrips} type="button">
          <Trash2 aria-hidden="true" />
          전체 데이터 삭제
        </button>
      </section>
    );
  }

  function renderCheckpointPrompt() {
    if (!checkpointPrompt || !currentTrip) {
      return null;
    }

    const checkpoint = currentTrip.checkpoints.find(
      (item) => item.id === checkpointPrompt.checkpointId,
    );
    const segment = currentTrip.segments.find((item) => item.id === checkpointPrompt.segmentId);

    if (!checkpoint || !segment) {
      return null;
    }

    return (
      <div className="dialog-backdrop">
        <section
          aria-labelledby="checkpoint-prompt-title"
          className="confirm-dialog checkpoint-dialog"
          role="dialog"
        >
          <div className="dialog-symbol">
            <Check aria-hidden="true" />
          </div>
          <div>
            <h2 id="checkpoint-prompt-title">체크포인트 정리</h2>
            <p>{formatTime(checkpoint.recordedAt)}에 통과한 지점입니다.</p>
          </div>
          <div className="prompt-segment">
            <strong>{getSegmentLabel(segment, currentTrip.checkpoints)}</strong>
            <span>{formatDuration(segment.durationMs)}</span>
            {checkpointPrompt.matchedPlaceId &&
            checkpointPrompt.matchedPlaceDistanceMeters !== null ? (
              <span className="history-match">
                이력 불러옴 · 약 {Math.round(checkpointPrompt.matchedPlaceDistanceMeters)}m
              </span>
            ) : null}
          </div>
          <div className="prompt-form">
            <label>
              구간 이동수단
              <TransportModeSelect
                id={`checkpoint-prompt-mode-${segment.id}`}
                onChange={(transportMode) => updateCheckpointPrompt({ transportMode })}
                value={checkpointPrompt.transportMode}
              />
            </label>
            <label>
              체크포인트 이름
              <input
                onChange={(event) => updateCheckpointPrompt({ name: event.target.value })}
                placeholder="체크포인트 이름"
                value={checkpointPrompt.name}
              />
            </label>
            <label>
              체크포인트 유형
              <select
                onChange={(event) =>
                  updateCheckpointPrompt({
                    type: event.target.value ? (event.target.value as CheckpointType) : null,
                  })
                }
                value={checkpointPrompt.type ?? ''}
              >
                <option value="">선택 안 함</option>
                {checkpointTypeOptions.map((type) => (
                  <option key={type} value={type}>
                    {checkpointTypeLabels[type]}
                  </option>
                ))}
              </select>
            </label>
            <label className="checkbox-row">
              <input
                checked={checkpointPrompt.savePlace}
                onChange={(event) => updateCheckpointPrompt({ savePlace: event.target.checked })}
                type="checkbox"
              />
              <span>
                {checkpointPrompt.matchedPlaceId ? '장소 이력 갱신' : '장소 이력에 저장'}
              </span>
            </label>
          </div>
          <div className="dialog-actions">
            <button className="secondary-button" onClick={skipCheckpointPrompt} type="button">
              나중에!
            </button>
            <button
              className="primary-button"
              onClick={() => {
                void saveCheckpointPrompt();
              }}
              type="button"
            >
              <Save aria-hidden="true" />
              입력 저장
            </button>
          </div>
        </section>
      </div>
    );
  }

  function renderMapCheckpointEditor() {
    if (!mapCheckpointEditor) {
      return null;
    }

    const editorTrip =
      mapCheckpointEditor.source === 'current'
        ? currentTrip
        : trips.find((trip) => trip.id === mapCheckpointEditor.tripId) ?? null;
    const checkpoint = editorTrip?.checkpoints.find(
      (item) => item.id === mapCheckpointEditor.checkpointId,
    );

    if (!editorTrip || !checkpoint) {
      return null;
    }

    const segment = mapCheckpointEditor.segmentId
      ? editorTrip.segments.find((item) => item.id === mapCheckpointEditor.segmentId)
      : null;
    const checkpointIndex = editorTrip.checkpoints.findIndex(
      (item) => item.id === mapCheckpointEditor.checkpointId,
    );
    const canEditStructure = canRemoveCheckpoint(editorTrip, mapCheckpointEditor.checkpointId);

    return (
      <div className="dialog-backdrop">
        <section
          aria-labelledby="map-checkpoint-editor-title"
          className="confirm-dialog checkpoint-dialog"
          role="dialog"
        >
          <div className="dialog-symbol">
            <MapPin aria-hidden="true" />
          </div>
          <div>
            <h2 id="map-checkpoint-editor-title">체크포인트 편집</h2>
            <p>{formatTime(mapCheckpointEditor.recordedAt)} 지점입니다.</p>
          </div>
          <div className="prompt-form">
            <label>
              이름
              <input
                onChange={(event) => updateMapCheckpointEditorDraft({ name: event.target.value })}
                placeholder="체크포인트 이름"
                value={mapCheckpointEditor.name}
              />
            </label>
            <label>
              유형
              <select
                onChange={(event) =>
                  updateMapCheckpointEditorDraft({
                    type: event.target.value ? (event.target.value as CheckpointType) : null,
                  })
                }
                value={mapCheckpointEditor.type ?? ''}
              >
                <option value="">선택 안 함</option>
                {checkpointTypeOptions.map((type) => (
                  <option key={type} value={type}>
                    {checkpointTypeLabels[type]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              메모
              <input
                onChange={(event) => updateMapCheckpointEditorDraft({ memo: event.target.value })}
                placeholder="체크포인트 메모"
                value={mapCheckpointEditor.memo}
              />
            </label>
            {segment ? (
              <label>
                이전 구간 이동수단
                <TransportModeSelect
                  id={`map-checkpoint-segment-mode-${segment.id}`}
                  onChange={(transportMode) =>
                    updateMapCheckpointEditorDraft({ transportMode })
                  }
                  value={mapCheckpointEditor.transportMode}
                />
              </label>
            ) : null}
          </div>
          {canEditStructure ? (
            <div className="checkpoint-action-column dialog-structure-actions">
              <button
                aria-label="체크포인트 삭제"
                className="checkpoint-icon-button danger"
                onClick={() =>
                  confirmCheckpointStructureEdit(
                    mapCheckpointEditor.source,
                    editorTrip.id,
                    mapCheckpointEditor.checkpointId,
                    'delete',
                  )
                }
                title="삭제"
                type="button"
              >
                <Trash2 aria-hidden="true" />
              </button>
              {checkpointIndex > 0 ? (
                <button
                  aria-label="이전 체크포인트와 병합"
                  className="checkpoint-icon-button merge-previous"
                  onClick={() =>
                    confirmCheckpointStructureEdit(
                      mapCheckpointEditor.source,
                      editorTrip.id,
                      mapCheckpointEditor.checkpointId,
                      'merge-previous',
                    )
                  }
                  title="이전과 병합"
                  type="button"
                >
                  <GitMerge aria-hidden="true" />
                </button>
              ) : null}
              {checkpointIndex < editorTrip.checkpoints.length - 1 ? (
                <button
                  aria-label="다음 체크포인트와 병합"
                  className="checkpoint-icon-button merge-next"
                  onClick={() =>
                    confirmCheckpointStructureEdit(
                      mapCheckpointEditor.source,
                      editorTrip.id,
                      mapCheckpointEditor.checkpointId,
                      'merge-next',
                    )
                  }
                  title="다음과 병합"
                  type="button"
                >
                  <GitMerge aria-hidden="true" />
                </button>
              ) : null}
            </div>
          ) : null}
          <div className="dialog-actions">
            <button
              className="secondary-button"
              onClick={() => setMapCheckpointEditor(null)}
              type="button"
            >
              취소
            </button>
            <button
              className="primary-button"
              onClick={() => {
                void saveMapCheckpointEditor();
              }}
              type="button"
            >
              <Save aria-hidden="true" />
              완료
            </button>
          </div>
        </section>
      </div>
    );
  }

  function renderActiveTripReturn() {
    if (!currentTrip || !isDraftRecordingStatus(recordingStatus)) {
      return null;
    }

    const targetView = getDraftView(recordingStatus);
    if (view === targetView) {
      return null;
    }

    return (
      <section className="warning-box active-trip-banner">
        <AlertCircle aria-hidden="true" />
        <div>
          <strong>진행 중인 기록이 있습니다</strong>
          <span>새로고침해도 복구되지만, 기록 조작은 기록 화면에서 진행해주세요.</span>
        </div>
        <button className="secondary-button" onClick={() => setView(targetView)} type="button">
          기록 화면
        </button>
      </section>
    );
  }

  function renderGpsStatus() {
    return (
      <div className={`gps-status ${gpsStatus.tone}`}>
        <LocateFixed aria-hidden="true" />
        <strong>{gpsStatus.label}</strong>
        <span>{gpsStatus.detail}</span>
      </div>
    );
  }

  function renderMissingTrip() {
    return (
      <EmptyState
        actionLabel="홈으로"
        icon={<AlertCircle aria-hidden="true" />}
        message="진행 중인 기록을 찾을 수 없습니다."
        onAction={() => setView('home')}
      />
    );
  }

  return (
    <main className="app-shell">
      <header className="app-header">
        <button className="brand-button" onClick={() => guardedSetView('home')} type="button">
          <Navigation aria-hidden="true" />
          <span>출근드림팀</span>
        </button>
        <nav aria-label="주요 화면">
          <button
            aria-current={view === 'home' ? 'page' : undefined}
            className="icon-button"
            onClick={() => guardedSetView('home')}
            title="홈"
            type="button"
          >
            <Home aria-hidden="true" />
          </button>
          <button
            aria-current={view === 'records' ? 'page' : undefined}
            className="icon-button"
            onClick={() => guardedSetView('records')}
            title="내 기록"
            type="button"
          >
            <List aria-hidden="true" />
          </button>
          <button
            aria-current={view === 'settings' ? 'page' : undefined}
            className="icon-button"
            onClick={() => guardedSetView('settings')}
            title="설정"
            type="button"
          >
            <Settings aria-hidden="true" />
          </button>
        </nav>
      </header>

      {storageError ? (
        <section className="warning-box" role="alert">
          <AlertCircle aria-hidden="true" />
          <strong>IndexedDB 저장소 오류</strong>
          <span>{storageError}</span>
        </section>
      ) : null}

      {notice ? <div className="toast">{notice}</div> : null}
      {renderActiveTripReturn()}
      {renderContent()}
      {renderMapCheckpointEditor()}
      {renderCheckpointPrompt()}
      <ConfirmDialog
        description={confirmState?.description ?? ''}
        onCancel={() => setConfirmState(null)}
        onConfirm={() => confirmState?.onConfirm()}
        open={confirmState !== null}
        title={confirmState?.title ?? ''}
        tone={confirmState?.tone}
        confirmLabel={confirmState?.confirmLabel}
      />
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function StatsGrid({ trip }: { trip: TripRecord }) {
  const recordedMs = Math.max(0, trip.totalDurationMs - trip.pausedDurationMs);

  return (
    <section className="stats-grid">
      <Metric label="총 소요 시간" value={formatDuration(trip.totalDurationMs)} />
      <Metric label="일시정지 시간" value={formatDuration(trip.pausedDurationMs)} />
      <Metric label="기록된 이동 시간" value={formatDuration(recordedMs)} />
      <Metric label="출발 시각" value={formatTime(trip.startedAt)} />
      <Metric label="도착 시각" value={trip.endedAt ? formatTime(trip.endedAt) : '-'} />
      <Metric label="체크포인트 수" value={`${trip.checkpoints.length}개`} />
    </section>
  );
}

function SegmentSummary({
  checkpoints,
  segments,
}: {
  checkpoints: Checkpoint[];
  segments: Segment[];
}) {
  if (segments.length === 0) {
    return <p className="muted">아직 생성된 구간이 없습니다.</p>;
  }

  return (
    <div className="segment-list">
      {segments.map((segment, index) => (
        <article className="segment-row" key={segment.id}>
          <span className="number-badge">{index + 1}</span>
          <div>
            <strong>{getSegmentLabel(segment, checkpoints)}</strong>
            <span>
              {formatDuration(segment.durationMs)} ·{' '}
              {segment.transportMode ? transportModeLabels[segment.transportMode] : '이동수단 미지정'}
            </span>
            {segment.memo ? <p>{segment.memo}</p> : null}
          </div>
        </article>
      ))}
    </div>
  );
}

function CompareMetric({
  label,
  base,
  target,
}: {
  label: string;
  base: number;
  target: number;
}) {
  const delta = target - base;
  const faster = delta < 0;

  return (
    <div className={`compare-metric ${faster ? 'good' : delta > 0 ? 'slow' : ''}`}>
      <span>{label}</span>
      <strong>{formatDelta(delta)}</strong>
      <small>{faster ? '이전보다 빠릅니다' : delta > 0 ? '이번 비교 기록이 더 깁니다' : '동일합니다'}</small>
    </div>
  );
}

function CompareCountMetric({
  label,
  base,
  target,
}: {
  label: string;
  base: number;
  target: number;
}) {
  const delta = target - base;

  return (
    <div className="compare-metric">
      <span>{label}</span>
      <strong>{delta === 0 ? '차이 없음' : `${delta > 0 ? '+' : ''}${delta}개`}</strong>
      <small>
        기준 {base}개 · 비교 {target}개
      </small>
    </div>
  );
}

function EmptyState({
  icon,
  message,
  actionLabel,
  onAction,
}: {
  icon: React.ReactNode;
  message: string;
  actionLabel: string;
  onAction: () => void;
}) {
  return (
    <section className="empty-state">
      {icon}
      <strong>{message}</strong>
      <button className="primary-button" onClick={onAction} type="button">
        {actionLabel}
      </button>
    </section>
  );
}

export default App;
