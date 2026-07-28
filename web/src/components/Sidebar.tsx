import { useEffect, useState } from 'react';
import { ApiRequestError } from '../api';
import { ChevronIcon, CloseIcon, LogOutIcon, TrashIcon } from '../icons';
import { useI18n } from '../i18n';
import { formatRelativeDay } from '../dates';
import type { SnapshotProbe } from '../App';
import type { Character, Conversation } from '../types';

export type AppView = 'chat' | 'profile' | 'market' | 'settings' | 'support' | 'examples';
type Props = {
  open: boolean;
  activeView: AppView;
  conversations: Conversation[];
  activeId: string | null;
  busy: boolean;
  character: Character | null;
  characters: Character[];
  snapshot: SnapshotProbe | null;
  portraitUrl: string | null;
  skillPoints: number | null;
  locationName: string | null;
  onClose: () => void;
  onView: (view: AppView) => void;
  onNew: () => void;
  onSelect: (id: string) => void;
  onDelete: (id: string) => Promise<void>;
  onConnect: () => void;
  onActivate: (characterId: number) => void;
  onLogout: () => void;
};

export function Sidebar({
  open, activeView, conversations, activeId, busy, character, characters,
  snapshot, portraitUrl, skillPoints, locationName,
  onClose, onView, onNew, onSelect, onDelete, onConnect, onActivate, onLogout,
}: Props) {
  const { t, locale } = useI18n();
  const [characterMenuOpen, setCharacterMenuOpen] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const nav: Array<{ id: AppView; label: string; count?: number }> = [
    { id: 'chat', label: t('chat'), count: conversations.length },
    { id: 'market', label: t('market') },
    { id: 'profile', label: t('profile') },
    { id: 'examples', label: t('examples') },
    { id: 'settings', label: t('settings') },
    { id: 'support', label: t('support') },
  ];
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  const confirmDelete = async (id: string) => {
    setConfirmDeleteId(null);
    try {
      await onDelete(id);
    } catch (reason) {
      // Сервер отвечает осмысленным текстом (например 409 про активный запрос);
      // сетевые сбои сводим к общему сообщению.
      setDeleteError(reason instanceof ApiRequestError ? reason.message : t('deleteConversationFailed'));
    }
  };

  const renderConversationRow = (conversation: Conversation) => {
    const active = conversation.id === activeId && activeView === 'chat';
    const className = `conversation-row${active ? ' conversation-row--active' : ''}`;
    if (confirmDeleteId === conversation.id) {
      return <div className={`${className} conversation-row--confirm`} key={conversation.id}>
        <span className="conversation-row__confirm-label">{t('deleteConversationConfirm')}</span>
        <button className="conversation-row__confirm-delete" type="button" disabled={busy} onClick={() => void confirmDelete(conversation.id)}>{t('deleteConversation')}</button>
        <button className="conversation-row__confirm-cancel" type="button" onClick={() => setConfirmDeleteId(null)}>{t('cancel')}</button>
      </div>;
    }
    return <div className={className} key={conversation.id}>
      <button className="conversation-row__main" type="button" onClick={() => onSelect(conversation.id)} disabled={busy} aria-current={active ? 'page' : undefined}>
        <span className="conversation-row__title">{conversation.title}</span>
        <span className="conversation-row__time">{formatRelativeDay(conversation.updatedAt, locale)}</span>
      </button>
      <button className="icon-button conversation-row__delete" type="button" disabled={busy} aria-label={t('deleteConversation')} onClick={(event) => { event.stopPropagation(); setDeleteError(null); setConfirmDeleteId(conversation.id); }}><TrashIcon size={16} /></button>
    </div>;
  };

  // Сервер отдаёт треды активного персонажа и гостевые (characterId: null);
  // гостевые показываем отдельной группой. Без активного персонажа — плоский список.
  const guestConversations = character ? conversations.filter((item) => item.characterId === null) : [];
  const mainConversations = character ? conversations.filter((item) => item.characterId !== null) : conversations;
  const status = describeSnapshot(snapshot, t);
  const accountMeta = [
    skillPoints === null ? null : t('dockSp').replace('{sp}', (skillPoints / 1_000_000).toFixed(1)),
    locationName,
  ].filter((part): part is string => Boolean(part)).join(' · ');

  return <><button className={`sidebar-scrim${open ? ' sidebar-scrim--open' : ''}`} type="button" aria-label={t('closeMenu')} onClick={onClose} /><aside className={`sidebar${open ? ' sidebar--open' : ''}`} aria-label={t('conversations')}>
    <div className="sidebar__brand">
      <span className="sun-disc" aria-hidden="true" />
      <span className="sidebar__brand-copy">
        <span className="sidebar__wordmark">EVE <em>AI</em></span>
        <span className="sidebar__tagline">{t('brandTagline')}</span>
      </span>
      <button className="icon-button sidebar__close" type="button" onClick={onClose} aria-label={t('closeMenu')}><CloseIcon size={20} /></button>
    </div>
    <div className={`status-pill${status.tone === 'ok' ? '' : ` status-pill--${status.tone}`}`} role="status">
      <span className="status-pill__dot" aria-hidden="true" />
      {t('statusEsiOnline')}<span className="status-pill__sep" aria-hidden="true">·</span><span className="status-pill__label">{status.label}</span>
    </div>
    <nav className="sidebar-nav" aria-label="Workspace">{nav.map(({ id, label, count }) => <button className={activeView === id ? 'sidebar-nav__item sidebar-nav__item--active' : 'sidebar-nav__item'} type="button" key={id} onClick={() => onView(id)}>
      <span>{label}</span>
      {count ? <span className="sidebar-nav__count">{count}</span> : null}
    </button>)}</nav>
    <button className="new-chat" type="button" onClick={onNew} disabled={busy}>{t('newThread')}</button>
    <div className="sidebar__section-title">{t('sessions')}</div>
    <nav className="conversation-list" aria-label={t('conversations')}>{conversations.length ? <>{mainConversations.map(renderConversationRow)}{guestConversations.length ? <><div className="conversation-list__group-title">{t('noCharacterConversations')}</div>{guestConversations.map(renderConversationRow)}</> : null}</> : <p className="conversation-list__empty">{t('noConversations')}</p>}{deleteError ? <p className="conversation-list__error" role="alert">{deleteError}</p> : null}</nav>
    <div className="sidebar__account">{characterMenuOpen ? <div className="character-switcher" aria-label={t('pilots')}><div className="character-switcher__title">{t('pilots')}</div>{characters.map((entry) => <button className={`character-option${entry.id === character?.id ? ' character-option--active' : ''}`} type="button" key={entry.id} disabled={busy || entry.id === character?.id} onClick={() => { setCharacterMenuOpen(false); onActivate(entry.id); }}><span className="character-option__avatar" aria-hidden="true">{entry.name.slice(0, 1).toUpperCase()}</span><span>{entry.name}</span>{entry.id === character?.id ? <small>{t('active')}</small> : null}</button>)}<button className="character-add" type="button" disabled={busy} onClick={() => { setCharacterMenuOpen(false); onConnect(); }}>{t('addPilot')}</button></div> : null}
      <button className="account-row" type="button" onClick={() => setCharacterMenuOpen((value) => !value)} disabled={busy} aria-expanded={characterMenuOpen}>
        <span className="account-avatar" aria-hidden="true">{portraitUrl ? <img src={portraitUrl} alt="" /> : (character?.name.slice(0, 1).toUpperCase() ?? '∞')}</span>
        <span className="account-row__copy">
          <strong>{character?.name ?? t('guest')}</strong>
          <span>{accountMeta || (character ? t('pilotConnected') : t('connectPilot'))}</span>
        </span>
        <span className={`account-row__chevron${characterMenuOpen ? ' account-row__chevron--open' : ''}`}><ChevronIcon size={18} /></span>
      </button>
      <button className="logout-action" type="button" onClick={onLogout} disabled={busy}><LogOutIcon size={16} />{t('logout')}</button>
    </div>
  </aside></>;
}

type StatusTone = 'ok' | 'warn' | 'down';

type StatusKey = 'statusChecking' | 'statusUnknown' | 'statusMarketOffline' | 'statusMarketStale' | 'statusMarketFresh' | 'statusMarketAge';

/** Статус-пилюля питается снапшотом рынка — единственным живым индикатором
 *  здоровья ESI, который браузерный API уже отдаёт. Пока статус не приехал,
 *  показываем «проверяем», а не оптимистичный ESI ONLINE; если опрос упал —
 *  честное «статус неизвестен», а не последнее удачное значение. */
function describeSnapshot(snapshot: SnapshotProbe | null, t: (key: StatusKey) => string): { tone: StatusTone; label: string } {
  if (!snapshot) return { tone: 'warn', label: t('statusChecking') };
  if (!snapshot.ok || !snapshot.meta) return { tone: 'down', label: t('statusUnknown') };
  const meta = snapshot.meta;
  if (!meta.loaded) return { tone: 'down', label: t('statusMarketOffline') };
  if (meta.stale) return { tone: 'warn', label: t('statusMarketStale') };
  if (meta.age_minutes === null) return { tone: 'ok', label: t('statusMarketFresh') };
  return { tone: 'ok', label: t('statusMarketAge').replace('{age}', String(Math.max(0, Math.round(meta.age_minutes)))) };
}
