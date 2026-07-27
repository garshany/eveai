import { useCallback } from 'react';
import { webApi } from '../../api';
import { useI18n } from '../../i18n';
import type { ProfileSkillsResponse } from '../../types';
import { formatQuantity } from '../market/format';
import { FreshnessBar, formatLocalDateTime, romanLevel, useProfileData, useProfileSync } from './shared';

type Props = { csrfToken: string };

/** Навыки: суммарные/нераспределённые SP и очередь обучения. */
export function SkillsPanel({ csrfToken }: Props) {
  const { locale, t } = useI18n();
  const loader = useCallback(() => webApi.profile.skills(), []);
  const { data, loading, error, reload } = useProfileData<ProfileSkillsResponse>(loader);
  const { syncing, sync } = useProfileSync(csrfToken, ['skills', 'skillqueue'], reload);

  if (loading && !data) return <div className="panel-loading">{t('loading')}…</div>;
  if (error) return <div className="workspace-error" role="alert">{error}<button type="button" onClick={() => void reload()}>{t('retry')}</button></div>;
  if (!data) return null;

  return (
    <section className="profile-panel">
      <FreshnessBar freshness={data.freshness} syncing={syncing} onSync={() => void sync()} />
      <div className="chart-stats">
        <article className="chart-stat">
          <span className="chart-stat__label">{t('profileTotalSp')}</span>
          <strong className="chart-stat__value">
            {data.totalSp === null ? '—' : `${formatQuantity(data.totalSp, locale)} ${t('skillPoints')}`}
          </strong>
        </article>
        <article className="chart-stat">
          <span className="chart-stat__label">{t('profileUnallocatedSp')}</span>
          <strong className="chart-stat__value">
            {data.unallocatedSp === null ? '—' : `${formatQuantity(data.unallocatedSp, locale)} ${t('skillPoints')}`}
          </strong>
        </article>
      </div>
      <h3 className="profile-panel__heading">{t('profileSkillQueue')}</h3>
      {data.queue.length === 0 ? <p className="profile-panel__empty">{t('profileQueueEmpty')}</p> : null}
      {data.queue.length > 0 ? (
        <div className="profile-table">
          <table>
            <thead>
              <tr>
                <th className="num">#</th>
                <th>{t('profileSkill')}</th>
                <th>{t('profileLevel')}</th>
                <th>{t('profileFinish')}</th>
              </tr>
            </thead>
            <tbody>
              {data.queue.map((entry) => (
                <tr key={entry.queuePosition}>
                  <td className="num">{entry.queuePosition + 1}</td>
                  <td>{entry.skillName ?? (entry.skillId === null ? '—' : `#${entry.skillId}`)}</td>
                  <td>{entry.finishedLevel === null ? '—' : romanLevel(entry.finishedLevel)}</td>
                  <td>{formatLocalDateTime(entry.finishDate, locale) ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
