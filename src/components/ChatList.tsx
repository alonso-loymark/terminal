import { LoaderCircle, MessageSquare, Pencil, Search, SquarePen, Trash2, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { newChat, openChat, renameChat, requestDeleteChat, startRenameChat } from '../lib/orchestratorActions';
import { relativeTime, searchChats } from '../lib/orchestratorChats';
import { formatCost } from '../lib/orchestratorModel';
import { shortcutLabel } from '../store/keymap';
import { selectProject, useOrchestrator, type ChatState } from '../store/orchestrator';
import { RenameInput } from './RenameInput';

/**
 * The chats of the active orchestrator's project, in the sidebar: search, new chat, open,
 * rename (double click, F2 or the pencil) and delete (with confirmation). Arrow keys move
 * between chats and open them; F2 / Supr act on the open one (keybindings `chats.*`).
 */
export function ChatList({ dir }: { dir: string }) {
  const project = useOrchestrator(selectProject(dir));
  const renaming = useOrchestrator((s) => s.renamingChat);
  const searchRequest = useOrchestrator((s) => s.searchRequest);
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const chats = useMemo(() => searchChats(project?.chats ?? [], query), [project?.chats, query]);
  const active = project?.activeChat ?? null;
  const busyChat = project?.busy?.chatId ?? null;

  useEffect(() => {
    if (!searchRequest) return;
    searchRef.current?.focus();
    searchRef.current?.select();
  }, [searchRequest]);

  const focusChat = (id: string) => listRef.current?.querySelector<HTMLElement>(`[data-chat-id="${CSS.escape(id)}"]`)?.focus();

  const onListKey = (event: KeyboardEvent<HTMLUListElement>) => {
    if (event.target instanceof HTMLInputElement) return;
    const at = chats.findIndex((c) => c.id === active);
    const go = (i: number) => {
      const chat = chats[Math.max(0, Math.min(chats.length - 1, i))];
      if (!chat) return;
      event.preventDefault();
      openChat(dir, chat.id);
      requestAnimationFrame(() => focusChat(chat.id));
    };
    if (event.key === 'ArrowDown') go(at + 1);
    else if (event.key === 'ArrowUp') go(at - 1);
    else if (event.key === 'Home') go(0);
    else if (event.key === 'End') go(chats.length - 1);
  };

  const onSearchKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (query) setQuery('');
      else searchRef.current?.blur();
    } else if (event.key === 'Enter' || event.key === 'ArrowDown') {
      const first = chats[0];
      if (!first) return;
      event.preventDefault();
      openChat(dir, first.id);
      if (event.key === 'Enter') setQuery('');
      requestAnimationFrame(() => focusChat(first.id));
    }
  };

  const newKey = shortcutLabel('orchestrator.newChat');
  const searchKey = shortcutLabel('orchestrator.searchChats');
  return (
    <div className="chat-panel" data-orch="chats">
      <div className="chat-panel-head">
        <label className="chat-search">
          <Search aria-hidden="true" />
          <input
            ref={searchRef}
            data-orch="chat-search"
            type="search"
            value={query}
            placeholder="Buscar chats"
            title={searchKey ? `Buscar en los chats (${searchKey})` : 'Buscar en los chats'}
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onSearchKey}
          />
          {query && (
            <button type="button" className="chat-search-clear" aria-label="Borrar la búsqueda" onClick={() => setQuery('')}>
              <X aria-hidden="true" />
            </button>
          )}
        </label>
        <button type="button" className="explorer-button" data-action="orch-new-chat" title={newKey ? `Chat nuevo (${newKey})` : 'Chat nuevo'} onClick={() => newChat(dir)}>
          <SquarePen aria-hidden="true" />
        </button>
      </div>
      <ul ref={listRef} className="chat-list" role="listbox" aria-label="Chats del proyecto" onKeyDown={onListKey}>
        {chats.map((chat) => (
          <ChatItem key={chat.id} dir={dir} chat={chat} active={chat.id === active} busy={chat.id === busyChat} renaming={renaming === chat.id} />
        ))}
        {chats.length === 0 && <li className="chat-empty">{query ? 'Ningún chat coincide.' : 'Sin chats todavía.'}</li>}
      </ul>
    </div>
  );
}

function ChatItem({ dir, chat, active, busy, renaming }: { dir: string; chat: ChatState; active: boolean; busy: boolean; renaming: boolean }) {
  const empty = (chat.messages?.length ?? chat.count) === 0;
  return (
    <li
      role="option"
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      className="chat-item"
      data-chat-id={chat.id}
      data-active={active || undefined}
      data-busy={busy || undefined}
      title={chat.title}
      onClick={() => openChat(dir, chat.id)}
      onDoubleClick={() => startRenameChat(dir, chat.id)}
    >
      {busy ? <LoaderCircle className="chat-item-icon spin" aria-label="trabajando" /> : <MessageSquare className="chat-item-icon" aria-hidden="true" />}
      <span className="chat-item-body">
        {renaming ? (
          <RenameInput
            initial={chat.title}
            label="Nombre del chat"
            onCommit={(value) => renameChat(dir, chat.id, value)}
            onCancel={() => useOrchestrator.setState({ renamingChat: null })}
          />
        ) : (
          <span className="chat-item-title" data-orch="chat-title">
            {chat.title}
          </span>
        )}
        <span className="chat-item-meta">
          {empty ? 'vacío' : relativeTime(chat.updatedAt)}
          {chat.costUsd > 0 ? ` · ${formatCost(chat.costUsd)}` : ''}
        </span>
      </span>
      {!renaming && (
        <span className="chat-item-actions">
          <button
            type="button"
            className="explorer-button"
            data-action="orch-rename-chat"
            title="Renombrar (F2)"
            onClick={(event) => {
              event.stopPropagation();
              startRenameChat(dir, chat.id);
            }}
          >
            <Pencil aria-hidden="true" />
          </button>
          <button
            type="button"
            className="explorer-button"
            data-action="orch-delete-chat"
            title={busy ? 'Tiene una tarea en curso' : 'Eliminar (Supr)'}
            disabled={busy}
            onClick={(event) => {
              event.stopPropagation();
              requestDeleteChat(dir, chat.id);
            }}
          >
            <Trash2 aria-hidden="true" />
          </button>
        </span>
      )}
    </li>
  );
}
