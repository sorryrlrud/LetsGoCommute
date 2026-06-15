import { Clock3, PauseCircle, TimerReset } from 'lucide-react';
import { formatDuration } from '../utils/duration';

interface TimerDisplayProps {
  totalDurationMs: number;
  pausedDurationMs: number;
  segmentDurationMs: number;
}

export function TimerDisplay({
  totalDurationMs,
  pausedDurationMs,
  segmentDurationMs,
}: TimerDisplayProps) {
  return (
    <div className="timer-board" aria-live="polite">
      <div className="timer-primary">
        <Clock3 aria-hidden="true" />
        <div>
          <span>총 경과 시간</span>
          <strong>{formatDuration(totalDurationMs)}</strong>
        </div>
      </div>
      <div className="timer-grid">
        <div>
          <TimerReset aria-hidden="true" />
          <span>현재 구간</span>
          <strong>{formatDuration(segmentDurationMs)}</strong>
        </div>
        <div>
          <PauseCircle aria-hidden="true" />
          <span>일시정지</span>
          <strong>{formatDuration(pausedDurationMs)}</strong>
        </div>
      </div>
    </div>
  );
}
