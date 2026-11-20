import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { cancelTurn, closePanel, detachBlock, openPreview, previewChat, sendChat } from '../lib/aiActions';
import { folderName, shortenPath } from '../lib/paths';
import { focusActiveTerminal } from '../lib/tabActions';
import { AI_PANEL_DEFAULT, AI_PANEL_MIN, conversationOf, isRunning, useAi, type AiTurn } from '../store/ai';
import { shortcutLabel } from '../store/keymap';
import { useSettings } from '../store/settings';
import { useSystem } from '../store/system';
import { selectActivePaneId, useWorkspace } from '../store/workspace';
import type { PaneId } from '../store/workspaceModel';
import { AiAnswer } from './AiAnswer';
import { AiErrorBox } from './AiErrorBox';

/** At most this share of the window, so the terminals keep room. */
const MAX_SHARE = 0.6;

function Thinking({ note }: { note: string | null }) {
  return (
    <div className="ai-thinking" role="status" data-part="thinking">
      <span className="ai-dots" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      {note ?? 'Pensando…'}
    </div>
  );
}

function TurnView({ turn }: { turn: AiTurn }) {
  const running = isRunning(turn);
  return (
    <article className="ai-turn" data-kind={turn.kind} data-status={turn.status} data-turn-id={turn.id}>
      <div className="ai-question">{turn.question}</div>
      {turn.text && <AiAnswer text={turn.text} paneId={turn.paneId} />}
      {running && (turn.status === 'thinking' || turn.note) && <Thinking note={turn.note} />}
      {turn.status === 'cancelled' && <div className="ai-cancelled">Cancelada.</div>}
      {turn.error && <AiErrorBox code={turn.error.code} message={turn.error.message} />}
      <div className="ai-turn-actions">
        {running && (
          <button type="button" className="ai-link" data-action="ai-cancel" onClick={() => cancelTurn(turn.id)}>
            Cancelar (Esc)
          </button>
        )}
        {turn.sent && (
          <button type="button" className="ai-link" data-action="ai-show-context" onClick={() => openPreview(turn.sent)}>
            Ver qué se envió
          </button>
        )}
      </div>
    </article>
  );
}

/** Drag the left edge to resize; double click for the default width. */
function Resizer() {
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    handle.dataset.dragging = '';
    const startX = event.clientX;
    const startWidth = useAi.getState().panelWidth;
    const onMove = (move: PointerEvent) => {
      const max = Math.max(AI_PANEL_MIN, window.innerWidth * MAX_SHARE);
      useAi.setState({ panelWidth: Math.round(Math.min(max, Math.max(AI_PANEL_MIN, startWidth - (move.clientX - startX)))) });
    };
    const onEnd = () => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onEnd);
      handle.removeEventListener('pointercancel', onEnd);
      delete handle.dataset.dragging;
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onEnd);
    handle.addEventListener('pointercancel', onEnd);
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Ancho del panel de IA"
      title="Arrastrar para cambiar el ancho; doble clic para el ancho por defecto"
      className="ai-resizer"
      onPointerDown={onPointerDown}
      onDoubleClick={() => useAi.setState({ panelWidth: AI_PANEL_DEFAULT })}
    />
  );
}

function ChatInput({ paneId, busy }: { paneId: PaneId; busy: AiTurn | null }) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  const inputRequest = useAi((s) => s.inputRequest);
  useEffect(() => {
    if (inputRequest) ref.current?.focus();
  }, [inputRequest]);

  const send = () => {
    if (!text.trim() || busy) return;
    const question = text;
    setText('');
    void sendChat(paneId, question);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      send();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      if (busy) cancelTurn(busy.id);
      else focusActiveTerminal();
    }
  };
  return (
    <form
      className="ai-input"
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
    >
      <textarea
        ref={ref}
        value={text}
        rows={Math.min(6, Math.max(2, text.split('\n').length))}
        placeholder="Preguntá sobre esta terminal (Enter envía, Shift+Enter nueva línea)"
        aria-label="Pregunta para la IA"
        spellCheck={false}
        onChange={(event) => setText(event.currentTarget.value)}
        onKeyDown={onKeyDown}
      />
      <div className="ai-input-actions">
        <button type="button" className="ai-link" data-action="ai-preview" onClick={() => void previewChat(paneId, text)}>
          Ver qué se envía
        </button>
        {busy ? (
          <button type="button" className="ai-button" data-action="ai-cancel" onClick={() => cancelTurn(busy.id)}>
            Cancelar
          </button>
        ) : (
          <button type="submit" className="ai-button primary" data-action="ai-send" disabled={!text.trim()}>
            Enviar
          </button>
        )}
      </div>
    </form>
  );
}

/**
 * Ctrl+Shift+I: a short chat about the active pane's terminal (no tools, no files: only the
 * context it is given, redacted). "Explicar / arreglar" answers land here too.
 */
export function AiPanel() {
  const open = useAi((s) => s.panelOpen);
  const width = useAi((s) => s.panelWidth);
  const enabled = useSettings((s) => s.settings.ai.enabled);
  const paneId = useWorkspace(selectActivePaneId);
  const cwd = useWorkspace((s) => (paneId ? (s.panes[paneId]?.cwd ?? s.panes[paneId]?.startCwd ?? null) : null));
  const home = useSystem((s) => s.homeDir);
  const conversation = useAi(useShallow((s) => conversationOf(s, paneId)));
  const scroller = useRef<HTMLDivElement>(null);
  const last = conversation.turns.at(-1);

  // Follow the answer as it streams, unless the user scrolled up to read.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 120) el.scrollTop = el.scrollHeight;
  }, [last?.text, last?.status, conversation.turns.length]);

  if (!open || !enabled || !paneId) return null;
  const busy = conversation.turns.find(isRunning) ?? null;
  const panelKey = shortcutLabel('ai.panel');

  return (
    <aside
      className="ai-panel"
      style={{ width }}
      aria-label="Panel de IA"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && busy && !event.defaultPrevented) {
          event.preventDefault();
          cancelTurn(busy.id);
        }
      }}
    >
      <header className="ai-header">
        <span className="ai-title">IA</span>
        <span className="ai-subtitle" title={cwd ?? undefined}>
          {cwd ? `${folderName(cwd)} · ${shortenPath(cwd, home, 40)}` : 'Terminal'}
        </span>
        <button type="button" className="ai-close" aria-label="Cerrar el panel de IA" title={panelKey ? `Cerrar (${panelKey})` : 'Cerrar'} onClick={closePanel}>
          ×
        </button>
      </header>
      <div ref={scroller} className="ai-turns">
        {conversation.turns.length === 0 && (
          <div className="ai-empty">
            <p>Preguntá sobre lo que pasa en esta terminal. La IA ve la carpeta, la shell, la rama de git y los bloques que agregues (menú de un bloque → «Agregar al chat»), con los secretos ocultos.</p>
            <p>No tiene herramientas ni acceso a archivos, y nada de lo que sugiere se ejecuta solo.</p>
          </div>
        )}
        {conversation.turns.map((turn) => (
          <TurnView key={turn.id} turn={turn} />
        ))}
      </div>
      {conversation.attachments.length > 0 && (
        <ul className="ai-attachments" aria-label="Bloques agregados como contexto">
          {conversation.attachments.map((a) => (
            <li key={a.id} className="ai-chip" data-block-id={a.blockId} data-error={a.block.exitCode ? '' : undefined} title={a.block.command}>
              <span className="ai-chip-text">{a.block.command}</span>
              {a.block.exitCode ? <span className="ai-chip-code">✗ {a.block.exitCode}</span> : null}
              <button type="button" aria-label="Quitar del contexto" onClick={() => detachBlock(paneId, a.id)}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <ChatInput key={paneId} paneId={paneId} busy={busy} />
      <Resizer />
    </aside>
  );
}
