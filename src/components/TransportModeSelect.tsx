import type { TransportMode } from '../types/trip';
import { transportModeLabels } from '../types/trip';

interface TransportModeSelectProps {
  id: string;
  value: TransportMode | null;
  onChange: (value: TransportMode) => void;
  describedBy?: string;
  invalid?: boolean;
}

const modes = Object.keys(transportModeLabels) as TransportMode[];

export function TransportModeSelect({
  describedBy,
  id,
  invalid = false,
  value,
  onChange,
}: TransportModeSelectProps) {
  return (
    <select
      aria-describedby={describedBy}
      aria-invalid={invalid}
      id={id}
      onChange={(event) => onChange(event.target.value as TransportMode)}
      value={value ?? ''}
    >
      <option value="" disabled>
        이동수단 선택
      </option>
      {modes.map((mode) => (
        <option key={mode} value={mode}>
          {transportModeLabels[mode]}
        </option>
      ))}
    </select>
  );
}
