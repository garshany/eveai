import { useCallback } from 'react';
import { webApi } from '../../api';
import { useI18n } from '../../i18n';
import type { ProfileAccessResponse } from '../../types';
import { FreshnessBar, formatLocalDateTime, useProfileData, useProfileSync } from './shared';

type Props = { csrfToken: string };

/** Доступ: группы прав (granted/missing скоупы) и статусы синка всех датасетов. */
export function AccessPanel({ csrfToken }: Props) {
  const { locale, t } = useI18n();
  const loader = useCallback(() => webApi.profile.access(), []);
  const { data, loading, error, reload } = useProfileData<ProfileAccessResponse>(loader);
  // Без datasets — сервер синкает весь набор (ALL_DATASET_IDS).
  const { syncing, sync } = useProfileSync(csrfToken, undefined, reload);

  if (loading && !data) return <div className="panel-loading">{t('loading')}…</div>;
  if (error) return <div className="workspace-error" role="alert">{error}<button type="button" onClick={() => void reload()}>{t('retry')}</button></div>;
  if (!data) return null;

  const statusText = (status: string) => {
    if (status === 'ok') return t('profileStatusOk');
    if (status === 'pending') return t('profileStatusPending');
    if (status === 'error') return t('profileStatusError');
    if (status === 'no_scope') return t('profileStatusNoScope');
    return status;
  };

  return (
    <section className="profile-panel">
      <FreshnessBar freshness={null} syncing={syncing} onSync={() => void sync()} />
      <h3 className="profile-panel__heading">{t('profileAccessGroups')}</h3>
      <div className="clone-grid">
        {data.groups.map((group) => (
          <article className="profile-card" key={group.id}>
            <header><span>{group.label}</span></header>
            <div>
              {group.granted.length > 0 ? (
                <small>
                  {`${t('profileGranted')}: `}
                  <span className="scope-list scope-list--granted">{group.granted.join(', ')}</span>
                </small>
              ) : null}
              {group.missing.length > 0 ? (
                <small>
                  {`${t('profileMissingScopes')}: `}
                  <span className="scope-list scope-list--missing">{group.missing.join(', ')}</span>
                </small>
              ) : null}
            </div>
          </article>
        ))}
      </div>
      <h3 className="profile-panel__heading">{t('profileAccessDatasets')}</h3>
      <div className="profile-table">
        <table>
          <thead>
            <tr>
              <th>{t('profileDataset')}</th>
              <th>{t('profileStatus')}</th>
              <th>{t('profileSyncedAt')}</th>
              <th>{t('profileError')}</th>
            </tr>
          </thead>
          <tbody>
            {data.datasets.map((dataset) => (
              <tr key={dataset.dataset}>
                <td>{dataset.dataset}</td>
                <td className={`sync-status sync-status--${dataset.status}`}>{statusText(dataset.status)}</td>
                <td>{formatLocalDateTime(dataset.syncedAt, locale) ?? '—'}</td>
                <td>{dataset.error ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
