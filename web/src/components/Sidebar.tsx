import { Brand } from './Brand';
import { ChatIcon, ChevronIcon, CloseIcon, LogOutIcon, PlusIcon } from '../icons';
import type { Character, Conversation } from '../types';

type SidebarProps = {
  open: boolean;
  conversations: Conversation[];
  activeId: string | null;
  busy: boolean;
  character: Character | null;
  onClose: () => void;
  onNew: () => void;
  onSelect: (id: string) => void;
  onConnect: () => void;
  onLogout: () => void;
};

export function Sidebar({
  open,
  conversations,
  activeId,
  busy,
  character,
  onClose,
  onNew,
  onSelect,
  onConnect,
  onLogout,
}: SidebarProps) {
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
          <button className="account-row" type="button" onClick={character ? undefined : onConnect} disabled={busy}>
            <span className="account-avatar" aria-hidden="true">
              {character?.name.slice(0, 1).toUpperCase() ?? '∞'}
            </span>
            <span className="account-row__copy">
              <strong>{character?.name ?? 'Гостевой режим'}</strong>
              <span>{character ? 'Персонаж подключён' : 'Подключить персонажа'}</span>
            </span>
            <ChevronIcon size={19} />
          </button>
          <button className="logout-action" type="button" onClick={onLogout} disabled={busy}>
            <LogOutIcon size={18} /> Выйти
          </button>
        </div>
      </aside>
    </>
  );
}
