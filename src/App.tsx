import {
  AlertCircle,
  Check,
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
import { useEffect, useMemo, useRef, useState } from 'react';
import { ConfirmDialog } from './components/ConfirmDialog';
import { MapView } from './components/MapView';
import { TimerDisplay } from './components/TimerDisplay';
import { TransportModeSelect } from './components/TransportModeSelect';
import { TripCard } from './components/TripCard';
import { storageAdapter } from './storage/IndexedDBStorageAdapter';
import type {
  Checkpoint,
  CheckpointType,
  GpsPoint,
  PauseRange,
  RecordingStatus,
  Segment,
  TripRecord,
} from './types/trip';
import { checkpointTypeLabels, transportModeLabels } from './types/trip';
import { formatDate, formatDateTime, formatTime, generateDefaultTripName } from './utils/date';
import { formatDelta, formatDuration, calculateTotalDuration } from './utils/duration';
import { generateId } from './utils/id';
import {
  buildSegmentsFromCheckpoints,
  calculatePausedDuration,
  findSimilarTrips,
  validateTripBeforeSave,
} from './utils/trip';
import './App.css';

const APP_VERSION = '0.1.0';
const GPS_SAVE_INTERVAL_MS = 10_000;

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

const checkpointTypeOptions = Object.keys(checkpointTypeLabels) as Exclude<
  CheckpointType,
  null
>[];

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

function App() {
  const [view, setView] = useState<AppView>('home');
  const [recordingStatus, setRecordingStatus] = useState<RecordingStatus>('idle');
  const [currentTrip, setCurrentTrip] = useState<TripRecord | null>(null);
  const [trips, setTrips] = useState<TripRecord[]>([]);
  const [currentPosition, setCurrentPosition] = useState<GpsPoint | null>(null);
  const [gpsStatus, setGpsStatus] = useState<GpsStatus>(() => getInitialGpsStatus());
  const [activePauseStartedAt, setActivePauseStartedAt] = useState<string | null>(null);
  const [selectedTripId, setSelectedTripId] = useState<string | null>(null);
  const [comparisonTargetId, setComparisonTargetId] = useState<string | null>(null);
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  const currentTripRef = useRef<TripRecord | null>(currentTrip);
  const recordingStatusRef = useRef<RecordingStatus>(recordingStatus);
  const activePauseStartedAtRef = useRef<string | null>(activePauseStartedAt);
  const lastSavedPointAtRef = useRef<number>(0);

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
    recordingStatusRef.current = recordingStatus;
  }, [recordingStatus]);

  useEffect(() => {
    activePauseStartedAtRef.current = activePauseStartedAt;
  }, [activePauseStartedAt]);

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    void loadTrips();
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

        const pointTime = new Date(point.recordedAt).getTime();
        if (pointTime - lastSavedPointAtRef.current < GPS_SAVE_INTERVAL_MS) {
          return;
        }

        lastSavedPointAtRef.current = pointTime;
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

  function showNotice(message: string) {
    setNotice(message);
    window.setTimeout(() => setNotice(null), 3600);
  }

  function requestConfirmation(state: ConfirmState) {
    setConfirmState(state);
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
      setRecordingStatus('recording');
      setView('recording');
      showNotice('출발! GPS 기록을 시작했습니다.');
    } catch (error) {
      showNotice(error instanceof Error ? error.message : '출발 위치를 확인하지 못했습니다.');
    }
  }

  function confirmCheckpoint() {
    requestConfirmation({
      title: '체크포인트를 기록할까요?',
      description: '현재 위치와 시간이 저장됩니다.',
      confirmLabel: '체크!',
      onConfirm: () => {
        void addCheckpoint();
      },
    });
  }

  async function addCheckpoint() {
    setConfirmState(null);

    if (!currentTripRef.current) {
      return;
    }

    try {
      const point = await requestFreshPosition();
      setCurrentTrip((trip) => {
        if (!trip) {
          return trip;
        }

        const checkpoint = createCheckpoint(
          point,
          trip.checkpoints.length,
          null,
          `체크포인트 ${trip.checkpoints.length + 1}`,
        );

        return {
          ...trip,
          points: [...trip.points, point],
          checkpoints: [...trip.checkpoints, checkpoint],
          updatedAt: point.recordedAt,
        };
      });
      lastSavedPointAtRef.current = new Date(point.recordedAt).getTime();
      showNotice('체크포인트 통과!');
    } catch (error) {
      showNotice(error instanceof Error ? error.message : '체크포인트 위치를 확인하지 못했습니다.');
    }
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
      const segments = buildSegmentsFromCheckpoints(checkpoints);
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
        setConfirmState(null);
        setCurrentTrip(null);
        setActivePauseStartedAt(null);
        setRecordingStatus('idle');
        setView('home');
        showNotice('임시 기록을 삭제했습니다.');
      },
    });
  }

  function updateTripName(name: string) {
    setCurrentTrip((trip) =>
      trip
        ? {
            ...trip,
            name,
            updatedAt: new Date().toISOString(),
          }
        : trip,
    );
  }

  function updateTripMemo(memo: string) {
    setCurrentTrip((trip) =>
      trip
        ? {
            ...trip,
            memo,
            updatedAt: new Date().toISOString(),
          }
        : trip,
    );
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
      await loadTrips();
      setCurrentTrip(tripToSave);
      setSelectedTripId(tripToSave.id);
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
      setTrips([]);
      setSelectedTripId(null);
      setComparisonTargetId(null);
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
            <button
              className="secondary-button"
              onClick={() => {
                void requestFreshPosition().catch((error) =>
                  showNotice(error instanceof Error ? error.message : '위치 확인 실패'),
                );
              }}
              type="button"
            >
              <LocateFixed aria-hidden="true" />
              현재 위치 확인
            </button>
          </div>
        </div>

        <div className="map-stage">
          <MapView currentPosition={currentPosition} points={[]} height="420px" />
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
          points={currentTrip.points}
          height="430px"
        />
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
        {renderGpsStatus()}
        <div className="bottom-controls">
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
        <MapView checkpoints={currentTrip.checkpoints} points={currentTrip.points} />
        <StatsGrid trip={currentTrip} />
        <section className="panel">
          <h2>구간별 소요 시간</h2>
          <SegmentSummary checkpoints={currentTrip.checkpoints} segments={currentTrip.segments} />
        </section>
        <div className="button-row">
          <button
            className="primary-button"
            onClick={() => {
              setRecordingStatus('editing');
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
          <h1>체크포인트와 이동수단 입력</h1>
        </div>

        <section className="panel form-panel">
          <label>
            기록 이름
            <input
              onChange={(event) => updateTripName(event.target.value)}
              value={currentTrip.name}
            />
          </label>
          <label>
            전체 기록 메모
            <textarea
              onChange={(event) => updateTripMemo(event.target.value)}
              placeholder="오늘 이동에 대한 메모"
              rows={3}
              value={currentTrip.memo}
            />
          </label>
        </section>

        <section className="panel form-panel">
          <h2>체크포인트 이름</h2>
          <div className="editor-list">
            {currentTrip.checkpoints.map((checkpoint) => (
              <article className="editor-item" key={checkpoint.id}>
                <div className="editor-heading">
                  <span className="number-badge">{checkpoint.order + 1}</span>
                  <strong>{formatTime(checkpoint.recordedAt)}</strong>
                </div>
                <label>
                  이름
                  <input
                    onChange={(event) =>
                      updateCheckpoint(checkpoint.id, { name: event.target.value })
                    }
                    placeholder="체크포인트 이름"
                    value={checkpoint.name}
                  />
                </label>
                <label>
                  유형
                  <select
                    onChange={(event) =>
                      updateCheckpoint(checkpoint.id, {
                        type: event.target.value
                          ? (event.target.value as CheckpointType)
                          : null,
                      })
                    }
                    value={checkpoint.type ?? ''}
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
                    onChange={(event) =>
                      updateCheckpoint(checkpoint.id, { memo: event.target.value })
                    }
                    placeholder="체크포인트 메모"
                    value={checkpoint.memo}
                  />
                </label>
              </article>
            ))}
          </div>
        </section>

        <section className="panel form-panel">
          <h2>구간별 이동수단</h2>
          <div className="editor-list">
            {currentTrip.segments.map((segment, index) => (
              <article className="editor-item" key={segment.id}>
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
                <label>
                  구간 메모
                  <input
                    onChange={(event) => updateSegment(segment.id, { memo: event.target.value })}
                    placeholder="구간 메모"
                    value={segment.memo}
                  />
                </label>
              </article>
            ))}
          </div>
        </section>

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
        <MapView checkpoints={selectedTrip.checkpoints} points={selectedTrip.points} />
        <StatsGrid trip={selectedTrip} />
        <section className="panel">
          <h2>체크포인트 목록</h2>
          <ol className="checkpoint-list">
            {selectedTrip.checkpoints.map((checkpoint) => (
              <li key={checkpoint.id}>
                <span className="number-badge">{checkpoint.order + 1}</span>
                <div>
                  <strong>{checkpoint.name}</strong>
                  <span>
                    {checkpoint.type ? checkpointTypeLabels[checkpoint.type] : '유형 없음'} ·{' '}
                    {formatTime(checkpoint.recordedAt)}
                  </span>
                  {checkpoint.memo ? <p>{checkpoint.memo}</p> : null}
                </div>
              </li>
            ))}
          </ol>
        </section>
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
                  points={selectedTrip.points}
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
          <Metric label="PWA" value="설치 가능 정적 웹앱" />
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
        <button className="brand-button" onClick={() => setView('home')} type="button">
          <Navigation aria-hidden="true" />
          <span>출근드림팀</span>
        </button>
        <nav aria-label="주요 화면">
          <button
            aria-current={view === 'home' ? 'page' : undefined}
            className="icon-button"
            onClick={() => setView('home')}
            title="홈"
            type="button"
          >
            <Home aria-hidden="true" />
          </button>
          <button
            aria-current={view === 'records' ? 'page' : undefined}
            className="icon-button"
            onClick={() => setView('records')}
            title="내 기록"
            type="button"
          >
            <List aria-hidden="true" />
          </button>
          <button
            aria-current={view === 'settings' ? 'page' : undefined}
            className="icon-button"
            onClick={() => setView('settings')}
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
      {renderContent()}
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
