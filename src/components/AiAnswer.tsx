import { TriangleAlert } from 'lucide-react';
import { useMemo } from 'react';
import { insertCommand } from '../lib/aiActions';
import { inlineParts, segments } from '../lib/aiPrompts';
import { destructiveReasons } from '../lib/aiSafety';
import { copyText } from '../lib/clipboard';
import type { PaneId } from '../store/workspaceModel';

/** `code` and **bold** inside a line of the answer. */
function Paragraph({ text }: { text: string }) {
  return (
    <p className="ai-paragraph">
      {inlineParts(text).map((part, i) =>
        part.type === 'code' ? <code key={i}>{part.text}</code> : part.type === 'bold' ? <strong key={i}>{part.text}</strong> : <span key={i}>{part.text}</span>,
      )}
    </p>
  );
}

/** A suggested command: insert (never run) or copy, with a warning if it destroys something. */
function CommandCard({ code, lang, closed, paneId }: { code: string; lang: string; closed: boolean; paneId: PaneId }) {
  const command = code.trim();
  const reasons = useMemo(() => destructiveReasons(command), [command]);
  return (
    <div className="ai-command" data-destructive={reasons.length ? '' : undefined}>
      <pre className="ai-command-code" data-lang={lang || undefined}>
        <code>{command}</code>
      </pre>
      {reasons.length > 0 && (
        <div className="ai-warning" role="alert" data-part="destructive-warning">
          <TriangleAlert aria-hidden="true" />
          <span>Comando destructivo: {reasons.join('; ')}. Revisalo antes de ejecutarlo.</span>
        </div>
      )}
      {closed && command && (
        <div className="ai-command-actions">
          <button
            type="button"
            className="ai-button"
            data-action="ai-insert"
            data-danger={reasons.length ? '' : undefined}
            title="Lo escribe en la terminal, sin ejecutarlo"
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => insertCommand(paneId, command)}
          >
            Insertar
          </button>
          <button type="button" className="ai-button" data-action="ai-copy" onPointerDown={(event) => event.preventDefault()} onClick={() => void copyText(command)}>
            Copiar
          </button>
        </div>
      )}
    </div>
  );
}

/** An answer of the AI: paragraphs and command blocks (also while it streams). */
export function AiAnswer({ text, paneId }: { text: string; paneId: PaneId }) {
  const parts = useMemo(() => segments(text), [text]);
  return (
    <div className="ai-answer">
      {parts.map((part, i) =>
        part.type === 'code' ? (
          <CommandCard key={i} code={part.code} lang={part.lang} closed={part.closed} paneId={paneId} />
        ) : (
          part.text.split(/\n{2,}|\n(?=\s*[-*•]\s)/).map((paragraph, j) => <Paragraph key={`${i}-${j}`} text={paragraph.trim()} />)
        ),
      )}
    </div>
  );
}
