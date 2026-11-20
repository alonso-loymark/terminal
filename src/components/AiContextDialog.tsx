import { useEffect, useRef } from 'react';
import { closePreview } from '../lib/aiActions';
import { copyText } from '../lib/clipboard';
import { describeRedactions } from '../lib/redact';
import { focusActiveTerminal } from '../lib/tabActions';
import { useAi } from '../store/ai';

const PROVIDERS = { 'claude-cli': 'Claude Code (claude -p, tu suscripción)', 'anthropic-api': 'API de Anthropic' } as const;

/** "Ver qué se envía": exactly what goes (or went) to the AI, already redacted. */
export function AiContextDialog() {
  const sent = useAi((s) => s.preview);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (sent) closeRef.current?.focus();
  }, [sent]);

  if (!sent) return null;
  const { payload } = sent;
  const close = () => {
    closePreview();
    if (!useAi.getState().bar) focusActiveTerminal();
  };
  const summary = describeRedactions(sent.redactions);
  const all = [`# Instrucciones\n${payload.system}`, ...payload.messages.map((m) => `# ${m.role === 'user' ? 'Mensaje' : 'Respuesta anterior'}\n${m.content}`)].join('\n\n');

  return (
    <div className="dialog-backdrop" onPointerDown={(event) => event.target === event.currentTarget && close()}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Lo que se envía a la IA"
        className="dialog ai-context"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            close();
          }
        }}
      >
        <h2>Lo que se envía a la IA</h2>
        <p>
          {PROVIDERS[payload.provider]} · modelo <code>{payload.model}</code>
          {payload.effort ? ` · esfuerzo ${payload.effort}` : ''}. Sin herramientas ni acceso a archivos.
        </p>
        <p data-part="redactions">
          {summary ? `Secretos ocultos: ${summary}.` : 'No se encontraron secretos para ocultar.'}
          {sent.envNames.length > 0 && ` Valores de variables de entorno ocultos: ${sent.envNames.join(', ')}.`}
        </p>
        <h3>Instrucciones (system prompt)</h3>
        <pre className="ai-context-text" data-part="system">
          {payload.system}
        </pre>
        {payload.messages.map((m, i) => (
          <section key={i}>
            <h3>{m.role === 'user' ? (payload.messages.length > 1 ? `Mensaje ${Math.ceil((i + 1) / 2)}` : 'Mensaje') : 'Respuesta anterior'}</h3>
            <pre className="ai-context-text" data-part="message" data-role={m.role}>
              {m.content}
            </pre>
          </section>
        ))}
        <div className="dialog-actions">
          <button type="button" data-action="ai-copy-context" onClick={() => void copyText(all)}>
            Copiar
          </button>
          <button ref={closeRef} type="button" className="primary" data-action="close" onClick={close}>
            Cerrar
          </button>
        </div>
      </div>
    </div>
  );
}
