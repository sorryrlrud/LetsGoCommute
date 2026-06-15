export function formatDuration(ms: number): string {
  const safeMs = Math.max(0, ms);
  const totalSeconds = Math.floor(safeMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}시간 ${minutes.toString().padStart(2, '0')}분 ${seconds
      .toString()
      .padStart(2, '0')}초`;
  }

  return `${minutes}분 ${seconds.toString().padStart(2, '0')}초`;
}

export function formatDelta(ms: number): string {
  if (ms === 0) {
    return '차이 없음';
  }

  return `${ms > 0 ? '+' : '-'}${formatDuration(Math.abs(ms))}`;
}

export function calculateTotalDuration(startedAt: string, endedAt: string): number {
  return Math.max(0, new Date(endedAt).getTime() - new Date(startedAt).getTime());
}
