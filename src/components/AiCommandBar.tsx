import { Sparkles, TriangleAlert } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { askCommand, cancelTurn, closeCommandBar, insertCommand, openPreview, previewCommand } from '../lib/aiActions';
import { commandAnswer } from '../lib/aiPrompts';
import { destructiveReasons } from '../lib/aiSafety';
import { focusActiveTerminal } from '../lib/tabActions';
import { isRunning, useAi } from '../store/ai';
import { useWorkspace } from '../store/workspace';
import type { Rect } from '../store/workspaceModel';
import { AiErrorBox } from './AiErrorBox';

const SHELL_LABELS: Record<string, string> = {
  powershell: 'PowerShell',
  pwsh: 'PowerShell',
  cmd: 'cmd',
  gitbash: 'bash',
  wsl: 'bash (WSL)',
  other: 'la shell',
};

/**
 * Ctrl+I: natural language to a command, over the pane it was opened on. Enter proposes;
 * Enter again inserts the command at the prompt WITHOUT running it; Escape cancels.
 */
export function AiCommandBar({ rect }: { rect: Rect }) {
  const bar = useAi((s) => s.bar);
  const shell = useWorkspace((s) => (bar ? (s.panes[bar.paneId]?.shell ?? null) : null));
  const [text, setText] = useState('');
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
  }, [bar?.paneId]);

  const turn = bar?.turn ?? null;
  const running = isRunning(turn);
  const answer = useMemo(() => (turn?.status === 'done' ? commandAnswer(turn.text) : null), [turn?.status, turn?.text]);
  const reasons = useMemo(() => (answer?.command ? destructiveReasons(answer.command) : []), [answer?.command]);
  if (!bar) return null;
  const stale = text.trim() !== (bar.askedFor ?? '').trim();
  const canInsert = !!answer?.command && !stale;

  const insert = () => {
    if (!answer?.command) return;
    if (!insertCommand(bar.paneId, answer.command)) return;
    useAi.setState({ bar: null });
    // The bar owned the keyboard until now: give it back to the terminal.
    focusActiveTerminal();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (running) return;
      if (canInsert) insert();
      else if (text.trim()) void askCommand(text);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      if (running && turn) cancelTurn(turn.id);
      else closeCommandBar();
    }
  };

  return (
    <div
      className="ai-bar-anchor"
      style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.w * 100}%` }}
    >
      <div className="ai-bar" role="dialog" aria-label="Lenguaje natural a comando" data-state={turn?.status ?? 'idle'}>
        <div className="ai-bar-row">
          <Sparkles className="ai-bar-icon" aria-hidden="true" />
          <input
            ref={input}
            value={text}
            placeholder={`Describí qué querés hacer: propongo un comando de ${SHELL_LABELS[shell ?? 'other'] ?? 'la shell'}`}
            aria-label="Qué querés hacer"
            spellCheck={false}
            onChange={(event) => setText(event.currentTarget.value)}
            onKeyDown={onKeyDown}
          />
          <button
            type="button"
            className="ai-link"
            data-action="ai-preview"
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => (turn?.sent && !stale ? openPreview(turn.sent) : void previewCommand(bar.paneId, text))}
          >
            Ver qué se envía
          </button>
        </div>
        {running && (
          <div className="ai-thinking" role="status" data-part="thinking">
            <span className="ai-dots" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
            {turn?.note ?? 'Pensando…'} <span className="ai-muted">(Esc cancela)</span>
          </div>
        )}
        {answer?.command && (
          <div className="ai-proposal" data-stale={stale ? '' : undefined} data-destructive={reasons.length ? '' : undefined}>
            <pre className="ai-command-code">
              <code data-part="proposed-command">{answer.command}</code>
            </pre>
            {answer.explanation && <p className="ai-paragraph" data-part="explanation">{answer.explanation}</p>}
            {reasons.length > 0 && (
              <div className="ai-warning" role="alert" data-part="destructive-warning">
                <TriangleAlert aria-hidden="true" />
              <span>Comando destructivo: {reasons.join('; ')}. Revisalo antes de ejecutarlo.</span>
              </div>
            )}
            <div className="ai-command-actions">
              <button
                type="button"
                className="ai-button primary"
                data-action="ai-insert"
                data-danger={reasons.length ? '' : undefined}
                disabled={!canInsert}
                onPointerDown={(event) => event.preventDefault()}
                onClick={insert}
              >
                Insertar sin ejecutar (Enter)
              </button>
              <span className="ai-muted">{stale ? 'Cambiaste el pedido: Enter propone otro comando.' : 'Esc cancela.'}</span>
            </div>
          </div>
        )}
        {answer && !answer.command && (
          <p className="ai-paragraph" data-part="refusal">
            {answer.refusal ? `No se puede con un comando: ${answer.refusal}` : answer.explanation || 'La IA no propuso ningún comando.'}
          </p>
        )}
        {turn?.status === 'cancelled' && <div className="ai-cancelled">Cancelada.</div>}
        {turn?.error && <AiErrorBox code={turn.error.code} message={turn.error.message} />}
      </div>
    </div>
  );
}
