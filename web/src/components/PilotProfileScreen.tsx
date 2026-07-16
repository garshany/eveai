import { useCallback, useEffect, useState } from 'react';
import { webApi } from '../api';
import { LocaleSwitch, useI18n } from '../i18n';
import { MenuIcon, PilotIcon } from '../icons';
import type { Character, PilotProfile, ProfileAvailability } from '../types';

type Props = { character: Character | null; onMenu: () => void; onConnect: () => void };

export function PilotProfileScreen({ character, onMenu, onConnect }: Props) {
  const { locale, t } = useI18n();
  const [profile, setProfile] = useState<PilotProfile | null>(null);
  const [loading, setLoading] = useState(Boolean(character));
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!character) { setProfile(null); setLoading(false); return; }
    setLoading(true); setError(null);
    try { setProfile((await webApi.getProfile()).profile); }
    catch (reason) { setError(reason instanceof Error ? reason.message : t('requestFailed')); }
    finally { setLoading(false); }
  }, [character, t]);

  useEffect(() => { void load(); }, [load]);

  return <section className="workspace-screen">
    <header className="workspace-header">
      <button className="icon-button chat-header__menu" type="button" onClick={onMenu} aria-label={t('openMenu')}><MenuIcon /></button>
      <div><span className="workspace-kicker">ESI · CAPSULEER</span><h1>{t('profileTitle')}</h1><p>{t('profileLead')}</p></div>
      <LocaleSwitch />
    </header>
    <div className="workspace-scroll">
      {!character ? <EmptyState icon={<PilotIcon size={38} />} title={t('noPilot')} action={t('connectPilot')} onAction={onConnect} /> : null}
      {loading ? <div className="panel-loading">{t('loading')}…</div> : null}
      {error ? <div className="workspace-error" role="alert">{error}<button type="button" onClick={() => void load()}>{t('refresh')}</button></div> : null}
      {profile ? <>
        <section className="pilot-hero">
          <img src={profile.character.portraitUrl} alt="" />
          <div className="pilot-identity"><span className={`online-pill ${profile.online ? 'online-pill--on' : ''}`}>{profile.online === null ? statusText(profile.availability.online, t) : profile.online ? t('online') : t('offline')}</span><h2>{profile.character.name}</h2><p>{profile.character.title || profile.corporation?.name || 'EVE Online'}</p><div className="pilot-affiliation"><span>{profile.corporation ? `${profile.corporation.name}${profile.corporation.ticker ? ` [${profile.corporation.ticker}]` : ''}` : t('unavailable')}</span><span>{profile.alliance ? `${profile.alliance.name}${profile.alliance.ticker ? ` [${profile.alliance.ticker}]` : ''}` : '—'}</span></div></div>
          <button className="button profile-refresh" type="button" onClick={() => void load()}>{t('refresh')}</button>
        </section>
        <div className="profile-grid">
          <ProfileCard title={t('location')} availability={profile.availability.location} t={t}><strong>{profile.location?.solarSystemName ?? '—'}</strong><small>{profile.location?.security === null || profile.location?.security === undefined ? '' : `security ${profile.location.security.toFixed(1)}`}</small></ProfileCard>
          <ProfileCard title={t('ship')} availability={profile.availability.ship} t={t}><strong>{profile.ship?.name || profile.ship?.typeName || '—'}</strong><small>{profile.ship?.name && profile.ship.typeName ? profile.ship.typeName : ''}</small></ProfileCard>
          <ProfileCard title={t('skills')} availability={profile.availability.skills} t={t}><strong>{profile.skills ? `${formatNumber(profile.skills.totalSp, locale)} ${t('skillPoints')}` : '—'}</strong><small>{profile.skills ? `${profile.skills.queued} ${t('queued')}` : ''}</small></ProfileCard>
          <ProfileCard title={t('wallet')} availability={profile.availability.wallet} t={t}><strong>{profile.wallet ? `${formatNumber(profile.wallet.balance, locale, 2)} ISK` : '—'}</strong><small>{t('balance')}</small></ProfileCard>
          <ProfileCard title={t('security')} availability={profile.availability.public} t={t}><strong>{profile.character.securityStatus?.toFixed(2) ?? '—'}</strong><small>{profile.location?.security === null || profile.location?.security === undefined ? '' : `${t('location')}: ${profile.location.security.toFixed(1)}`}</small></ProfileCard>
          <ProfileCard title={t('born')} availability={profile.availability.public} t={t}><strong>{profile.character.birthday ? new Intl.DateTimeFormat(locale === 'ru' ? 'ru-RU' : 'en-US', { dateStyle: 'medium' }).format(new Date(profile.character.birthday)) : '—'}</strong><small>ID {profile.character.id}</small></ProfileCard>
        </div>
      </> : null}
    </div>
  </section>;
}

function ProfileCard({ title, availability, t, children }: { title: string; availability: ProfileAvailability; t: (key: any) => string; children: React.ReactNode }) {
  return <article className="profile-card"><header><span>{title}</span><em className={`availability availability--${availability}`}>{statusText(availability, t)}</em></header><div>{children}</div></article>;
}

function statusText(value: ProfileAvailability, t: (key: any) => string) { return value === 'missing_scope' ? t('missingScope') : value === 'unavailable' ? t('unavailable') : 'ESI'; }
function formatNumber(value: number, locale: 'ru' | 'en', digits = 0) { return new Intl.NumberFormat(locale === 'ru' ? 'ru-RU' : 'en-US', { maximumFractionDigits: digits }).format(value); }
function EmptyState({ icon, title, action, onAction }: { icon: React.ReactNode; title: string; action: string; onAction: () => void }) { return <div className="workspace-empty">{icon}<h2>{title}</h2><button className="button button--primary" type="button" onClick={onAction}>{action}</button></div>; }
