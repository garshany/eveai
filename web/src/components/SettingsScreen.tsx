import { useCallback, useEffect, useState } from 'react';
import { ApiRequestError, webApi } from '../api';
import { LocaleSwitch, useI18n } from '../i18n';
import { MenuIcon } from '../icons';
import type { ModelPricing, ModelSettingsPayload } from '../types';

type Props = { csrfToken: string; onMenu: () => void };

type EffortKey = 'settingsEffortAuto' | 'settingsEffortNone' | 'settingsEffortLow' | 'settingsEffortMedium' | 'settingsEffortHigh' | 'settingsEffortXhigh' | 'settingsEffortMax';
type VerbosityKey = 'settingsVerbosityLow' | 'settingsVerbosityMedium' | 'settingsVerbosityHigh';
type ModelKey = 'settingsModelSol' | 'settingsModelTerra' | 'settingsModelLuna';
type SettingsErrorKey = 'settingsErrorUnknownModel' | 'settingsErrorInvalidEffort' | 'settingsErrorInvalidVerbosity' | 'settingsErrorCharacterRequired';

const EFFORT_LABELS: Record<string, EffortKey> = {
  auto: 'settingsEffortAuto',
  none: 'settingsEffortNone',
  low: 'settingsEffortLow',
  medium: 'settingsEffortMedium',
  high: 'settingsEffortHigh',
  xhigh: 'settingsEffortXhigh',
  max: 'settingsEffortMax',
};

const VERBOSITY_LABELS: Record<string, VerbosityKey> = {
  low: 'settingsVerbosityLow',
  medium: 'settingsVerbosityMedium',
  high: 'settingsVerbosityHigh',
};

const MODEL_DESCRIPTIONS: Record<string, ModelKey> = {
  'gpt-5.6-sol': 'settingsModelSol',
  'gpt-5.6-terra': 'settingsModelTerra',
  'gpt-5.6-luna': 'settingsModelLuna',
};

/** Server error codes from /api/web/settings/model → localized client text. */
const SETTINGS_ERROR_LABELS: Record<string, SettingsErrorKey> = {
  unknown_model: 'settingsErrorUnknownModel',
  invalid_reasoning_effort: 'settingsErrorInvalidEffort',
  invalid_verbosity: 'settingsErrorInvalidVerbosity',
  character_required: 'settingsErrorCharacterRequired',
};

export function SettingsScreen({ csrfToken, onMenu }: Props) {
  const { t } = useI18n();
  const [payload, setPayload] = useState<ModelSettingsPayload | null>(null);
  const [model, setModel] = useState('');
  const [reasoningEffort, setReasoningEffort] = useState('');
  const [verbosity, setVerbosity] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const applyPayload = (next: ModelSettingsPayload) => {
    setPayload(next);
    setModel(next.settings.model);
    setReasoningEffort(next.settings.reasoningEffort);
    setVerbosity(next.settings.verbosity);
  };

  const describeError = useCallback((reason: unknown): string => {
    if (reason instanceof ApiRequestError && reason.code && SETTINGS_ERROR_LABELS[reason.code]) {
      return t(SETTINGS_ERROR_LABELS[reason.code]!);
    }
    return reason instanceof Error ? reason.message : t('requestFailed');
  }, [t]);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try { applyPayload(await webApi.getModelSettings()); }
    catch (reason) { setError(describeError(reason)); }
    finally { setLoading(false); }
  }, [describeError]);

  useEffect(() => { void load(); }, [load]);

  const save = async () => {
    setSaving(true); setNotice(null); setError(null);
    try {
      applyPayload(await webApi.saveModelSettings(
        { model, reasoning_effort: reasoningEffort, verbosity },
        csrfToken,
      ));
      setNotice(t('settingsSaved'));
    } catch (reason) {
      setError(describeError(reason));
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    setSaving(true); setNotice(null); setError(null);
    try {
      applyPayload(await webApi.resetModelSettings(csrfToken));
      setNotice(t('settingsResetDone'));
    } catch (reason) {
      setError(describeError(reason));
    } finally {
      setSaving(false);
    }
  };

  const locked = payload !== null && !payload.canCustomize;
  const dirty = payload !== null && (
    model !== payload.settings.model
    || reasoningEffort !== payload.settings.reasoningEffort
    || verbosity !== payload.settings.verbosity
  );

  return <section className="workspace-screen">
    <header className="workspace-header">
      <button className="icon-button chat-header__menu" type="button" onClick={onMenu} aria-label={t('openMenu')}><MenuIcon /></button>
      <div><span className="workspace-kicker">{t('settingsKicker')}</span><h1>{t('settingsTitle')}</h1><p>{t('settingsLead')}</p></div>
      <LocaleSwitch />
    </header>
    <div className="workspace-scroll">
      {loading ? <div className="panel-loading">{t('loading')}…</div> : null}
      {error ? <div className="workspace-error" role="alert">{error}<button type="button" onClick={() => void load()}>{t('refresh')}</button></div> : null}
      {payload ? <>
        {payload.settings.isDefault ? <p className="settings-note">{t('settingsDefaultNote')}</p> : null}
        {locked ? <p className="settings-note settings-note--locked">{t('settingsGuestNote')}</p> : null}
        <section className="support-panel">
          <header className="support-panel__head"><h2>{t('settingsModelTitle')}</h2><small>{t('settingsTariffLegend')}</small></header>
          <div className="settings-model-grid" role="radiogroup" aria-label={t('settingsModelTitle')}>
            {payload.options.models.map((option) => {
              const selected = model === option.id;
              const isServerDefault = option.id === payload.defaults.model;
              return <button
                className={`settings-model-card${selected ? ' settings-model-card--active' : ''}`}
                type="button"
                role="radio"
                aria-checked={selected}
                key={option.id}
                disabled={locked}
                onClick={() => { setModel(option.id); setNotice(null); }}
              >
                <header>
                  <strong>{option.id}</strong>
                  {isServerDefault ? <em className="support-badge">{t('settingsDefaultBadge')}</em> : null}
                </header>
                <p>{MODEL_DESCRIPTIONS[option.id] ? t(MODEL_DESCRIPTIONS[option.id]!) : ''}</p>
                <small>{option.tariff ? formatTariff(option.tariff) : t('settingsTariffMissing')}</small>
              </button>;
            })}
          </div>
        </section>
        <section className="support-panel">
          <header className="support-panel__head"><h2>{t('settingsReasoningTitle')}</h2></header>
          <select
            className="market-select settings-select"
            value={reasoningEffort}
            disabled={locked}
            onChange={(event) => { setReasoningEffort(event.target.value); setNotice(null); }}
          >
            {payload.options.reasoningEfforts.map((effort) => (
              <option value={effort} key={effort}>
                {EFFORT_LABELS[effort] ? t(EFFORT_LABELS[effort]!) : effort}
                {effort === payload.defaults.reasoningEffort ? ` · ${t('settingsDefaultBadge')}` : ''}
              </option>
            ))}
          </select>
        </section>
        <section className="support-panel">
          <header className="support-panel__head"><h2>{t('settingsVerbosityTitle')}</h2></header>
          <select
            className="market-select settings-select"
            value={verbosity}
            disabled={locked}
            onChange={(event) => { setVerbosity(event.target.value); setNotice(null); }}
          >
            {payload.options.verbosities.map((level) => (
              <option value={level} key={level}>
                {VERBOSITY_LABELS[level] ? t(VERBOSITY_LABELS[level]!) : level}
                {level === payload.defaults.verbosity ? ` · ${t('settingsDefaultBadge')}` : ''}
              </option>
            ))}
          </select>
        </section>
        <div className="settings-actions">
          <button className="button button--primary" type="button" disabled={saving || !dirty || locked} onClick={() => void save()}>
            {saving ? t('settingsSaving') : t('settingsSave')}
          </button>
          {!payload.settings.isDefault ? (
            <button className="button" type="button" disabled={saving} onClick={() => void reset()}>
              {t('settingsReset')}
            </button>
          ) : null}
          {notice ? <span className="settings-saved" role="status">{notice}</span> : null}
        </div>
      </> : null}
    </div>
  </section>;
}

function formatTariff(tariff: ModelPricing): string {
  return [tariff.input, tariff.output, tariff.cached, tariff.reasoning].map((value) => `$${value}`).join(' / ');
}
