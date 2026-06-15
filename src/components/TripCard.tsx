import { Eye, Trash2 } from 'lucide-react';
import type { TripRecord } from '../types/trip';
import { transportModeLabels } from '../types/trip';
import { formatDate, formatTime } from '../utils/date';
import { formatDuration } from '../utils/duration';
import { getPrimaryTransportMode } from '../utils/trip';

interface TripCardProps {
  trip: TripRecord;
  onOpen: (tripId: string) => void;
  onDelete: (tripId: string) => void;
}

export function TripCard({ trip, onOpen, onDelete }: TripCardProps) {
  const primaryMode = getPrimaryTransportMode(trip);

  return (
    <article className="trip-card">
      <div className="trip-card-main">
        <span className="pill">오늘의 기록</span>
        <h3>{trip.name}</h3>
        <p>{formatDate(trip.startedAt)}</p>
      </div>
      <dl className="trip-card-stats">
        <div>
          <dt>출발</dt>
          <dd>{formatTime(trip.startedAt)}</dd>
        </div>
        <div>
          <dt>도착</dt>
          <dd>{trip.endedAt ? formatTime(trip.endedAt) : '-'}</dd>
        </div>
        <div>
          <dt>총 소요</dt>
          <dd>{formatDuration(trip.totalDurationMs)}</dd>
        </div>
        <div>
          <dt>일시정지</dt>
          <dd>{formatDuration(trip.pausedDurationMs)}</dd>
        </div>
        <div>
          <dt>체크</dt>
          <dd>{trip.checkpoints.length}개</dd>
        </div>
        <div>
          <dt>주요 수단</dt>
          <dd>{transportModeLabels[primaryMode as keyof typeof transportModeLabels]}</dd>
        </div>
      </dl>
      <div className="trip-card-actions">
        <button className="secondary-button" onClick={() => onOpen(trip.id)} type="button">
          <Eye aria-hidden="true" />
          상세
        </button>
        <button className="danger-button subtle" onClick={() => onDelete(trip.id)} type="button">
          <Trash2 aria-hidden="true" />
          삭제
        </button>
      </div>
    </article>
  );
}
