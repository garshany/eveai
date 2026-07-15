import { CompassMark } from '../icons';

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`brand${compact ? ' brand--compact' : ''}`} aria-label="EVE AI">
      <CompassMark className="brand__mark" size={compact ? 28 : 38} />
      <span className="brand__wordmark">EVE <strong>AI</strong></span>
    </div>
  );
}
