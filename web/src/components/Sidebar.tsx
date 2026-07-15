import { useState } from 'react';
import { Brand } from './Brand';
import { ChatIcon, ChevronIcon, CloseIcon, LogOutIcon, PlusIcon } from '../icons';
import type { Character, Conversation } from '../types';

type SidebarProps = {
  open: boolean;
  conversations: Conversation[];
  activeId: string | null;
  busy: boolean;
  character: Character | null;
  characters: Character[];
  onClose: () => void;
  onNew: () => void;
  onSelect: (id: string) => void;
  onConnect: () => void;
  onActivate: (characterId: number) => void;
  onLogout: () => void;
};

export function Sidebar({
  open,
  conversations,
  activeId,
  busy,
  character,
  characters,
  onClose,
  onNew,
  onSelect,
  onConnect,
  onActivate,
  onLogout,
}: SidebarProps) {
  const [characterMenuOpen, setCharacterMenuOpen] = useState(false);

  return (
    <>
      <button
        className={`sidebar-scrim${open ? ' sidebar-scrim--open' : ''}`}
        type="button"
        aria-label="Закрыть меню"
        onClick={onClose}
      />
      <aside className={`sidebar${open ? ' sidebar--open' : ''}`} aria-label="Диалоги">
        <div className="sidebar__brand-row">
          <Brand compact />
          <button className="icon-button sidebar__close" type="button" onClick={onClose} aria-label="Закрыть меню">
            <CloseIcon size={21} />
          </button>
        </div>

        <button className="new-chat" type="button" onClick={onNew} disabled={busy}>
          <PlusIcon size={21} />
          Новый диалог
        </button>

        <div className="sidebar__section-title">Диалоги</div>
        <nav className="conversation-list" aria-label="Список диалогов">
          {conversations.length > 0 ? conversations.map((conversation) => (
            <button
              className={`conversation-row${conversation.id === activeId ? ' conversation-row--active' : ''}`}
              type="button"
              key={conversation.id}
              onClick={() => onSelect(conversation.id)}
              disabled={busy}
              aria-current={conversation.id === activeId ? 'page' : undefined}
            >
              <ChatIcon size={20} />
              <span>{conversation.title}</span>
            </button>
          )) : (
            <p className="conversation-list__empty">Первый диалог появится после вашего вопроса.</p>
          )}
        </nav>

        <div className="sidebar__account">
          {characterMenuOpen && (
            <div className="character-switcher" aria-label="Подключённые персонажи">
              <div className="character-switcher__title">Капсулёры</div>
              {characters.map((entry) => (
                <button
                  className={`character-option${entry.id === character?.id ? ' character-option--active' : ''}`}
                  type="button"
                  key={entry.id}
                  disabled={busy || entry.id === character?.id}
                  onClick={() => {
                    setCharacterMenuOpen(false);
                    onActivate(entry.id);
                  }}
                >
                  <span className="character-option__avatar" aria-hidden="true">
                    {entry.name.slice(0, 1).toUpperCase()}
                  </span>
                  <span>{entry.name}</span>
                  {entry.id === character?.id && <small>активен</small>}
                </button>
              ))}
              <button
                className="character-add"
                type="button"
                disabled={busy}
                onClick={() => {
                  setCharacterMenuOpen(false);
                  onConnect();
                }}
              >
                <PlusIcon size={17} /> Добавить капсулёра
              </button>
              <p>Каждый персонаж подключается отдельно через EVE SSO.</p>
            </div>
          )}
          <button
            className="account-row"
            type="button"
            onClick={() => setCharacterMenuOpen((current) => !current)}
            disabled={busy}
            aria-expanded={characterMenuOpen}
          >
            <span className="account-avatar" aria-hidden="true">
              {character?.name.slice(0, 1).toUpperCase() ?? '∞'}
            </span>
            <span className="account-row__copy">
              <strong>{character?.name ?? 'Гостевой режим'}</strong>
              <span>{character ? 'Персонаж подключён' : 'Подключить персонажа'}</span>
            </span>
            <span className={`account-row__chevron${characterMenuOpen ? ' account-row__chevron--open' : ''}`}>
              <ChevronIcon size={19} />
            </span>
          </button>
          <button className="logout-action" type="button" onClick={onLogout} disabled={busy}>
            <LogOutIcon size={18} /> Выйти
          </button>
        </div>
      </aside>
    </>
  );
}
