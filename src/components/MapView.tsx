import L, { type LatLngExpression } from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useEffect, useRef, useState } from 'react';
import type { Checkpoint, GpsPoint } from '../types/trip';

interface MapViewProps {
  points: GpsPoint[];
  checkpoints?: Checkpoint[];
  currentPosition?: GpsPoint | null;
  comparePoints?: GpsPoint[];
  height?: string;
}

const fallbackCenter: LatLngExpression = [37.5665, 126.978];

function toLatLng(point: GpsPoint): LatLngExpression {
  return [point.lat, point.lng];
}

function makeMarkerIcon(label: string, tone: 'start' | 'end' | 'check' | 'current') {
  return L.divIcon({
    className: `map-marker ${tone}`,
    html: `<span>${label}</span>`,
    iconSize: [32, 32],
    iconAnchor: [16, 16],
  });
}

export function MapView({
  points,
  checkpoints = [],
  currentPosition,
  comparePoints = [],
  height = '360px',
}: MapViewProps) {
  const mapElementRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layersRef = useRef<L.LayerGroup | null>(null);
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

    return () => {
      map.remove();
      mapRef.current = null;
      layersRef.current = null;
    };
  }, []);

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
      const marker = L.marker([checkpoint.lat, checkpoint.lng], {
        icon: makeMarkerIcon(label, tone),
      }).bindPopup(`${checkpoint.name || `체크포인트 ${index + 1}`}<br />${checkpoint.recordedAt}`);

      marker.addTo(layers);
      bounds.push([checkpoint.lat, checkpoint.lng]);
    });

    if (currentPosition) {
      L.marker(toLatLng(currentPosition), {
        icon: makeMarkerIcon('●', 'current'),
      }).addTo(layers);
      bounds.push(toLatLng(currentPosition));
    }

    if (bounds.length >= 2) {
      map.fitBounds(L.latLngBounds(bounds), { padding: [32, 32], maxZoom: 17 });
    } else if (bounds.length === 1) {
      map.setView(bounds[0], 16);
    }
  }, [checkpoints, comparePoints, currentPosition, points]);

  return (
    <div className="map-shell" style={{ minHeight: height }}>
      <div ref={mapElementRef} className="leaflet-map" style={{ height }} />
      {mapError ? <p className="inline-error">{mapError}</p> : null}
    </div>
  );
}
