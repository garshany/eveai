import { useCallback } from 'react';
import { webApi } from '../../api';
import { useI18n } from '../../i18n';
import type { ProfileClonesResponse, ProfileImplant } from '../../types';
import { FreshnessBar, useProfileData, useProfileSync } from './shared';

type Props = { csrfToken: string };

/** Клоны: текущие импланты, домашняя станция и джамп-клоны с имплантами. */
export function ClonesPanel({ csrfToken }: Props) {
  const { t } = useI18n();
  const loader = useCallback(() => webApi.profile.clones(), []);
  const { data, loading, error, reload } = useProfileData<ProfileClonesResponse>(loader);
  const { syncing, sync } = useProfileSync(csrfToken, ['clones'], reload);

  if (loading && !data) return <div className="panel-loading">{t('loading')}…</div>;
  if (error) return <div className="workspace-error" role="alert">{error}<button type="button" onClick={() => void reload()}>{t('retry')}</button></div>;
  if (!data) return null;

  return (
    <section className="profile-panel">
      <FreshnessBar freshness={data.freshness} syncing={syncing} onSync={() => void sync()} />
      <div className="clone-grid">
        <article className="profile-card">
          <header><span>{t('profileCurrentImplants')}</span></header>
          <div>
            {data.currentImplants.length === 0
              ? <small>{t('profileNoImplants')}</small>
              : <ImplantList implants={data.currentImplants} />}
          </div>
        </article>
        <article className="profile-card">
          <header><span>{t('profileHomeStation')}</span></header>
          <div>
            {data.home
              ? <strong>{data.home.locationName ?? `#${data.home.locationId}`}</strong>
              : <small>{t('profileNoHome')}</small>}
          </div>
        </article>
      </div>
      <h3 className="profile-panel__heading">{t('profileJumpClones')}</h3>
      {data.jumpClones.length === 0 ? <p className="profile-panel__empty">{t('profileNoJumpClones')}</p> : null}
      <div className="clone-grid">
        {data.jumpClones.map((clone) => (
          <article className="profile-card" key={clone.jumpCloneId}>
            <header><span>{clone.name || `#${clone.jumpCloneId}`}</span></header>
            <div>
              <strong>{clone.locationName ?? (clone.locationId === null ? '—' : `#${clone.locationId}`)}</strong>
              {clone.implants.length === 0
                ? <small>{t('profileNoImplants')}</small>
                : <ImplantList implants={clone.implants} />}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function ImplantList({ implants }: { implants: ProfileImplant[] }) {
  return (
    <ul className="implant-list">
      {implants.map((implant) => <li key={implant.typeId}>{implant.typeName ?? `#${implant.typeId}`}</li>)}
    </ul>
  );
}
