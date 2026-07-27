import { useEffect, useState } from 'react';
import { ApiRequestError } from '../api';
import { Brand } from './Brand';
import { ChartIcon, ChatIcon, ChevronIcon, CloseIcon, GearIcon, LogOutIcon, MarketIcon, PilotIcon, PlusIcon, TrashIcon } from '../icons';
import { useI18n } from '../i18n';
import type { Character, Conversation } from '../types';

export type AppView = 'chat' | 'profile' | 'market' | 'settings' | 'support';
type Props = { open: boolean; activeView: AppView; conversations: Conversation[]; activeId: string | null; busy: boolean; character: Character | null; characters: Character[]; onClose: () => void; onView: (view: AppView) => void; onNew: () => void; onSelect: (id: string) => void; onDelete: (id: string) => Promise<void>; onConnect: () => void; onActivate: (characterId: number) => void; onLogout: () => void };

export function Sidebar({ open, activeView, conversations, activeId, busy, character, characters, onClose, onView, onNew, onSelect, onDelete, onConnect, onActivate, onLogout }: Props) {
  const { t } = useI18n();
  const [characterMenuOpen, setCharacterMenuOpen] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const nav = [
    { id: 'chat' as const, label: t('chat'), Icon: ChatIcon },
    { id: 'market' as const, label: t('market'), Icon: MarketIcon },
    { id: 'profile' as const, label: t('profile'), Icon: PilotIcon },
    { id: 'settings' as const, label: t('settings'), Icon: GearIcon },
    { id: 'support' as const, label: t('support'), Icon: ChartIcon },
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
      <button className="conversation-row__main" type="button" onClick={() => onSelect(conversation.id)} disabled={busy} aria-current={active ? 'page' : undefined}><ChatIcon size={20} /><span>{conversation.title}</span></button>
      <button className="icon-button conversation-row__delete" type="button" disabled={busy} aria-label={t('deleteConversation')} onClick={(event) => { event.stopPropagation(); setDeleteError(null); setConfirmDeleteId(conversation.id); }}><TrashIcon size={17} /></button>
    </div>;
  };

  // Сервер отдаёт треды активного персонажа и гостевые (characterId: null);
  // гостевые показываем отдельной группой. Без активного персонажа — плоский список.
  const guestConversations = character ? conversations.filter((item) => item.characterId === null) : [];
  const mainConversations = character ? conversations.filter((item) => item.characterId !== null) : conversations;

  return <><button className={`sidebar-scrim${open ? ' sidebar-scrim--open' : ''}`} type="button" aria-label={t('closeMenu')} onClick={onClose} /><aside className={`sidebar${open ? ' sidebar--open' : ''}`} aria-label={t('conversations')}>
    <div className="sidebar__brand-row"><Brand compact /><button className="icon-button sidebar__close" type="button" onClick={onClose} aria-label={t('closeMenu')}><CloseIcon size={21} /></button></div>
    <nav className="sidebar-nav" aria-label="Workspace">{nav.map(({ id, label, Icon }) => <button className={activeView === id ? 'sidebar-nav__item sidebar-nav__item--active' : 'sidebar-nav__item'} type="button" key={id} onClick={() => onView(id)}><Icon size={20} /><span>{label}</span></button>)}</nav>
    <button className="new-chat" type="button" onClick={onNew} disabled={busy}><PlusIcon size={21} />{t('newChat')}</button>
    <div className="sidebar__section-title">{t('conversations')}</div>
    <nav className="conversation-list" aria-label={t('conversations')}>{conversations.length ? <>{mainConversations.map(renderConversationRow)}{guestConversations.length ? <><div className="conversation-list__group-title">{t('noCharacterConversations')}</div>{guestConversations.map(renderConversationRow)}</> : null}</> : <p className="conversation-list__empty">{t('noConversations')}</p>}{deleteError ? <p className="conversation-list__error" role="alert">{deleteError}</p> : null}</nav>
    <div className="sidebar__account">{characterMenuOpen ? <div className="character-switcher" aria-label={t('pilots')}><div className="character-switcher__title">{t('pilots')}</div>{characters.map((entry) => <button className={`character-option${entry.id === character?.id ? ' character-option--active' : ''}`} type="button" key={entry.id} disabled={busy || entry.id === character?.id} onClick={() => { setCharacterMenuOpen(false); onActivate(entry.id); }}><span className="character-option__avatar" aria-hidden="true">{entry.name.slice(0, 1).toUpperCase()}</span><span>{entry.name}</span>{entry.id === character?.id ? <small>{t('active')}</small> : null}</button>)}<button className="character-add" type="button" disabled={busy} onClick={() => { setCharacterMenuOpen(false); onConnect(); }}><PlusIcon size={17} />{t('addPilot')}</button></div> : null}
      <button className="account-row" type="button" onClick={() => setCharacterMenuOpen((value) => !value)} disabled={busy} aria-expanded={characterMenuOpen}><span className="account-avatar" aria-hidden="true">{character?.name.slice(0, 1).toUpperCase() ?? '∞'}</span><span className="account-row__copy"><strong>{character?.name ?? t('guest')}</strong><span>{character ? t('pilotConnected') : t('connectPilot')}</span></span><span className={`account-row__chevron${characterMenuOpen ? ' account-row__chevron--open' : ''}`}><ChevronIcon size={19} /></span></button>
      <button className="logout-action" type="button" onClick={onLogout} disabled={busy}><LogOutIcon size={18} />{t('logout')}</button>
    </div>
  </aside></>;
}
