import { useI18n } from '../../i18n';
import type { MarketRegion } from '../../types';

type Props = {
  regions: MarketRegion[];
  value: number | null;
  onChange: (regionId: number) => void;
  disabled?: boolean;
};

export function RegionSelect({ regions, value, onChange, disabled }: Props) {
  const { t } = useI18n();
  return (
    <label className="market-region">
      <span className="market-region__label">{t('marketRegion')}</span>
      <select
        className="market-select"
        value={value ?? ''}
        disabled={disabled || regions.length === 0}
        onChange={(event) => onChange(Number(event.target.value))}
      >
        {regions.map((region) => (
          <option key={region.region_id} value={region.region_id}>{region.name}</option>
        ))}
      </select>
    </label>
  );
}
