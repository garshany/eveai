import { useState } from 'react';
import { Brand } from './Brand';
import { ChatIcon, ChevronIcon, CloseIcon, LogOutIcon, PilotIcon, PlusIcon, RadarIcon } from '../icons';
import { useI18n } from '../i18n';
import type { Character, Conversation } from '../types';

export type AppView = 'chat' | 'profile' | 'scan';
type Props = { open: boolean; activeView: AppView; conversations: Conversation[]; activeId: string | null; busy: boolean; character: Character | null; characters: Character[]; onClose: () => void; onView: (view: AppView) => void; onNew: () => void; onSelect: (id: string) => void; onConnect: () => void; onActivate: (characterId: number) => void; onLogout: () => void };

export function Sidebar({ open, activeView, conversations, activeId, busy, character, characters, onClose, onView, onNew, onSelect, onConnect, onActivate, onLogout }: Props) {
  const { t } = useI18n();
  const [characterMenuOpen, setCharacterMenuOpen] = useState(false);
  const nav = [{ id: 'chat' as const, label: t('chat'), Icon: ChatIcon }, { id: 'profile' as const, label: t('profile'), Icon: PilotIcon }, { id: 'scan' as const, label: t('scan'), Icon: RadarIcon }];
  return <><button className={`sidebar-scrim${open ? ' sidebar-scrim--open' : ''}`} type="button" aria-label={t('closeMenu')} onClick={onClose} /><aside className={`sidebar${open ? ' sidebar--open' : ''}`} aria-label={t('conversations')}>
    <div className="sidebar__brand-row"><Brand compact /><button className="icon-button sidebar__close" type="button" onClick={onClose} aria-label={t('closeMenu')}><CloseIcon size={21} /></button></div>
    <nav className="sidebar-nav" aria-label="Workspace">{nav.map(({ id, label, Icon }) => <button className={activeView === id ? 'sidebar-nav__item sidebar-nav__item--active' : 'sidebar-nav__item'} type="button" key={id} onClick={() => onView(id)}><Icon size={20} /><span>{label}</span></button>)}</nav>
    <button className="new-chat" type="button" onClick={onNew} disabled={busy}><PlusIcon size={21} />{t('newChat')}</button>
    <div className="sidebar__section-title">{t('conversations')}</div>
    <nav className="conversation-list" aria-label={t('conversations')}>{conversations.length ? conversations.map((conversation) => <button className={`conversation-row${conversation.id === activeId && activeView === 'chat' ? ' conversation-row--active' : ''}`} type="button" key={conversation.id} onClick={() => onSelect(conversation.id)} disabled={busy} aria-current={conversation.id === activeId && activeView === 'chat' ? 'page' : undefined}><ChatIcon size={20} /><span>{conversation.title}</span></button>) : <p className="conversation-list__empty">{t('noConversations')}</p>}</nav>
    <div className="sidebar__account">{characterMenuOpen ? <div className="character-switcher" aria-label={t('pilots')}><div className="character-switcher__title">{t('pilots')}</div>{characters.map((entry) => <button className={`character-option${entry.id === character?.id ? ' character-option--active' : ''}`} type="button" key={entry.id} disabled={busy || entry.id === character?.id} onClick={() => { setCharacterMenuOpen(false); onActivate(entry.id); }}><span className="character-option__avatar" aria-hidden="true">{entry.name.slice(0, 1).toUpperCase()}</span><span>{entry.name}</span>{entry.id === character?.id ? <small>{t('active')}</small> : null}</button>)}<button className="character-add" type="button" disabled={busy} onClick={() => { setCharacterMenuOpen(false); onConnect(); }}><PlusIcon size={17} />{t('addPilot')}</button></div> : null}
      <button className="account-row" type="button" onClick={() => setCharacterMenuOpen((value) => !value)} disabled={busy} aria-expanded={characterMenuOpen}><span className="account-avatar" aria-hidden="true">{character?.name.slice(0, 1).toUpperCase() ?? '∞'}</span><span className="account-row__copy"><strong>{character?.name ?? t('guest')}</strong><span>{character ? t('pilotConnected') : t('connectPilot')}</span></span><span className={`account-row__chevron${characterMenuOpen ? ' account-row__chevron--open' : ''}`}><ChevronIcon size={19} /></span></button>
      <button className="logout-action" type="button" onClick={onLogout} disabled={busy}><LogOutIcon size={18} />{t('logout')}</button>
    </div>
  </aside></>;
}
