import L, { type LatLngExpression } from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import type { Checkpoint, GpsPoint, Segment, TransportMode } from '../types/trip';
import { checkpointTypeLabels, transportModeLabels } from '../types/trip';
import { formatTime } from '../utils/date';
import { calculateTotalDuration, formatDuration } from '../utils/duration';

interface MapViewProps {
  points: GpsPoint[];
  checkpoints?: Checkpoint[];
  currentPosition?: GpsPoint | null;
  comparePoints?: GpsPoint[];
  segments?: Segment[];
  height?: string;
  viewKey?: string;
}

const fallbackCenter: LatLngExpression = [37.5665, 126.978];
const emptyCheckpoints: Checkpoint[] = [];
const emptyPoints: GpsPoint[] = [];
const emptySegments: Segment[] = [];

interface SegmentDisplay {
  durationMs: number;
  transportMode: TransportMode | null;
}

const transportModeIcons: Record<TransportMode, string> = {
  walk: '🚶',
  bus: '🚌',
  subway: '🚇',
  train: '🚆',
  bike: '🚲',
  kickboard: '🛴',
  public_transport: '↔',
  other: '•',
};

function toLatLng(point: GpsPoint): LatLngExpression {
  return [point.lat, point.lng];
}

function escapeHtml(value: string) {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[character] ?? character,
  );
}

function formatMapDuration(ms: number) {
  const safeMs = Math.max(0, ms);
  const totalSeconds = Math.floor(safeMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}시간 ${minutes.toString().padStart(2, '0')}분`;
  }

  return `${minutes}분 ${seconds.toString().padStart(2, '0')}초`;
}

function getSegmentDisplay(
  checkpoint: Checkpoint,
  index: number,
  checkpoints: Checkpoint[],
  segments: Segment[],
): SegmentDisplay | null {
  if (index === 0) {
    return null;
  }

  const matchedSegment =
    segments.find((segment) => segment.toCheckpointId === checkpoint.id) ?? segments[index - 1];

  if (matchedSegment) {
    return {
      durationMs: matchedSegment.durationMs,
      transportMode: matchedSegment.transportMode,
    };
  }

  const previousCheckpoint = checkpoints[index - 1];
  if (!previousCheckpoint) {
    return null;
  }

  return {
    durationMs: calculateTotalDuration(previousCheckpoint.recordedAt, checkpoint.recordedAt),
    transportMode: null,
  };
}

function makeCheckpointIcon(
  label: string,
  tone: 'start' | 'end' | 'check',
  checkpoint: Checkpoint,
  segment: SegmentDisplay | null,
) {
  const segmentHtml = segment
    ? `<span class="map-marker-segment"><span class="transport-icon">${
        segment.transportMode ? transportModeIcons[segment.transportMode] : '?'
      }</span>${escapeHtml(formatMapDuration(segment.durationMs))}</span>`
    : '<span class="map-marker-segment muted">출발</span>';

  return L.divIcon({
    className: `map-checkpoint-marker ${tone}`,
    html: `<span class="map-marker-pin">${label}</span><span class="map-marker-meta"><time>${escapeHtml(
      formatTime(checkpoint.recordedAt),
    )}</time>${segmentHtml}</span>`,
    iconSize: [176, 48],
    iconAnchor: [16, 16],
  });
}

function makeCurrentMarkerIcon() {
  return L.divIcon({
    className: 'map-current-marker',
    html: '<span class="map-current-dot">●</span>',
    iconSize: [32, 32],
    iconAnchor: [16, 16],
  });
}

function buildCheckpointPopup(
  checkpoint: Checkpoint,
  index: number,
  segment: SegmentDisplay | null,
) {
  const rows = [
    `<strong>${escapeHtml(checkpoint.name || `체크포인트 ${index + 1}`)}</strong>`,
    `<span>체크포인트 시간: ${escapeHtml(formatTime(checkpoint.recordedAt))}</span>`,
    `<span>유형: ${escapeHtml(
      checkpoint.type ? checkpointTypeLabels[checkpoint.type] : '유형 없음',
    )}</span>`,
  ];

  if (segment) {
    rows.push(`<span>이동 시간: ${escapeHtml(formatDuration(segment.durationMs))}</span>`);
    rows.push(
      `<span>이동 수단: ${
        segment.transportMode ? transportModeIcons[segment.transportMode] : '?'
      } ${escapeHtml(
        segment.transportMode ? transportModeLabels[segment.transportMode] : '미지정',
      )}</span>`,
    );
  }

  return `<div class="map-popup">${rows.join('')}</div>`;
}

function pointKey(point: GpsPoint | undefined | null) {
  return point
    ? `${point.lat.toFixed(6)},${point.lng.toFixed(6)},${point.recordedAt}`
    : 'none';
}

function getAutoFitKey(
  points: GpsPoint[],
  checkpoints: Checkpoint[],
  currentPosition: GpsPoint | null | undefined,
  comparePoints: GpsPoint[],
) {
  const firstCheckpoint = checkpoints[0];
  const lastCheckpoint = checkpoints.at(-1);

  return [
    points.length,
    pointKey(points[0]),
    pointKey(points.at(-1)),
    checkpoints.length,
    firstCheckpoint?.id ?? 'none',
    lastCheckpoint?.id ?? 'none',
    comparePoints.length,
    pointKey(comparePoints[0]),
    pointKey(comparePoints.at(-1)),
    pointKey(currentPosition),
  ].join('|');
}

function applyMapViewChange(
  map: L.Map,
  applyingViewChangeRef: MutableRefObject<boolean>,
  change: () => void,
) {
  applyingViewChangeRef.current = true;
  change();
  window.setTimeout(() => {
    applyingViewChangeRef.current = false;
  }, 0);
}

export function MapView({
  points,
  checkpoints = emptyCheckpoints,
  currentPosition,
  comparePoints = emptyPoints,
  segments = emptySegments,
  height = '360px',
  viewKey = 'default',
}: MapViewProps) {
  const mapElementRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layersRef = useRef<L.LayerGroup | null>(null);
  const applyingViewChangeRef = useRef(false);
  const userAdjustedMapRef = useRef(false);
  const lastAutoFitKeyRef = useRef<string | null>(null);
  const [mapError, setMapError] = useState<string | null>(null);

  useEffect(() => {
    if (!mapElementRef.current || mapRef.current) {
      return;
    }

    const map = L.map(mapElementRef.current, {
      center: fallbackCenter,
      zoom: 12,
      zoomControl: true,
    });

    const tileLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 19,
    });

    tileLayer.on('tileerror', () => {
      setMapError('지도를 불러오지 못했습니다. 네트워크 상태를 확인해주세요.');
    });

    tileLayer.addTo(map);
    layersRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;

    const handleUserViewChange = () => {
      if (!applyingViewChangeRef.current) {
        userAdjustedMapRef.current = true;
      }
    };

    map.on('movestart zoomstart', handleUserViewChange);

    return () => {
      map.off('movestart zoomstart', handleUserViewChange);
      map.remove();
      mapRef.current = null;
      layersRef.current = null;
    };
  }, []);

  useEffect(() => {
    userAdjustedMapRef.current = false;
    lastAutoFitKeyRef.current = null;
  }, [viewKey]);

  useEffect(() => {
    const map = mapRef.current;
    const layers = layersRef.current;

    if (!map || !layers) {
      return;
    }

    layers.clearLayers();
    const bounds: LatLngExpression[] = [];

    if (points.length > 0) {
      const latLngs = points.map(toLatLng);
      L.polyline(latLngs, {
        color: '#0f8a5f',
        weight: 5,
        opacity: 0.92,
      }).addTo(layers);
      bounds.push(...latLngs);
    }

    if (comparePoints.length > 0) {
      const latLngs = comparePoints.map(toLatLng);
      L.polyline(latLngs, {
        color: '#e0475b',
        dashArray: '8 8',
        weight: 5,
        opacity: 0.85,
      }).addTo(layers);
      bounds.push(...latLngs);
    }

    checkpoints.forEach((checkpoint, index) => {
      const isStart = index === 0;
      const isEnd = index === checkpoints.length - 1;
      const tone = isStart ? 'start' : isEnd ? 'end' : 'check';
      const label = isStart ? 'S' : isEnd ? 'G' : `${index}`;
      const segment = getSegmentDisplay(checkpoint, index, checkpoints, segments);
      const marker = L.marker([checkpoint.lat, checkpoint.lng], {
        icon: makeCheckpointIcon(label, tone, checkpoint, segment),
      }).bindPopup(buildCheckpointPopup(checkpoint, index, segment));

      marker.addTo(layers);
      bounds.push([checkpoint.lat, checkpoint.lng]);
    });

    if (currentPosition) {
      L.marker(toLatLng(currentPosition), {
        icon: makeCurrentMarkerIcon(),
      }).addTo(layers);
      bounds.push(toLatLng(currentPosition));
    }

    const autoFitKey = getAutoFitKey(points, checkpoints, currentPosition, comparePoints);
    const shouldAutoFit =
      bounds.length > 0 &&
      !userAdjustedMapRef.current &&
      lastAutoFitKeyRef.current !== autoFitKey;

    if (shouldAutoFit) {
      lastAutoFitKeyRef.current = autoFitKey;
      applyMapViewChange(map, applyingViewChangeRef, () => {
        if (bounds.length >= 2) {
          map.fitBounds(L.latLngBounds(bounds), {
            animate: false,
            padding: [32, 32],
            maxZoom: 17,
          });
        } else {
          map.setView(bounds[0], 16, { animate: false });
        }
      });
    }
  }, [checkpoints, comparePoints, currentPosition, points, segments, viewKey]);

  return (
    <div className="map-shell" style={{ minHeight: height }}>
      <div ref={mapElementRef} className="leaflet-map" style={{ height }} />
      {mapError ? <p className="inline-error">{mapError}</p> : null}
    </div>
  );
}
