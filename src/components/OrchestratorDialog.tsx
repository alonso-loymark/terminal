import { useEffect, useMemo, useRef, useState } from 'react';
import { copyText } from '../lib/clipboard';
import { imagePreview } from '../lib/imagePaste';
import { closeDialog, confirmInstructions, editDialogContent } from '../lib/orchestratorActions';
import { lineDiff } from '../lib/orchestratorModel';
import { describeRedactions } from '../lib/redact';
import { focusActiveTerminal } from '../lib/tabActions';
import { useOrchestrator } from '../store/orchestrator';

/**
 * The orchestrator's dialogs: AGENTS.md / CLAUDE.md with the exact text that would be written
 * (editable; nothing is written or committed without "Crear" / "Guardar"), and "Ver qué se
 * envió" (the plan's or the task's payload, already redacted).
 */
export function OrchestratorDialog() {
  const dialog = useOrchestrator((s) => s.dialog);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (dialog) cancelRef.current?.focus();
  }, [dialog?.kind]);

  if (!dialog) return null;
  const close = () => {
    closeDialog();
    focusActiveTerminal();
  };
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  };

  if (dialog.kind === 'sent') {
    const { sent } = dialog;
    const summary = describeRedactions(sent.redactions);
    return (
      <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && close()}>
        <div role="dialog" aria-modal="true" aria-label="Lo que se envió" className="dialog ai-context" data-orch="sent-dialog" onKeyDown={onKeyDown}>
          <h2>{sent.kind === 'plan' ? 'Lo que se envió para el plan' : 'Lo que recibió el trabajador'}</h2>
          <p>
            Claude Code · modelo <code>{sent.model}</code>
            {sent.effort ? ` · esfuerzo ${sent.effort}` : ''}.{' '}
            {sent.kind === 'plan'
              ? 'Sin herramientas ni acceso a archivos.'
              : 'En la carpeta del proyecto: lee y edita archivos y solo ejecuta los comandos permitidos. Claude Code agrega su propio prompt de sistema y las reglas de Brisa para trabajadores.'}
          </p>
          <p data-part="redactions">
            {summary ? `Secretos ocultos: ${summary}.` : 'No se encontraron secretos para ocultar.'}
            {sent.envNames.length > 0 && ` Valores de variables de entorno ocultos: ${sent.envNames.join(', ')}.`}
          </p>
          {sent.system && (
            <>
              <h3>Instrucciones (system prompt)</h3>
              <pre className="ai-context-text" data-part="system">
                {sent.system}
              </pre>
            </>
          )}
          <h3>{sent.kind === 'plan' ? 'Mensaje' : 'Brief de la tarea'}</h3>
          <pre className="ai-context-text" data-part="message">
            {sent.prompt}
          </pre>
          {sent.images && sent.images.length > 0 && (
            <>
              <h3>Imágenes adjuntas ({sent.images.length})</h3>
              <p className="settings-hint">Van tal cual, como PNG: una imagen no se puede redactar. Revisá que no muestre secretos.</p>
              <div className="orch-sent-images" data-part="images">
                {sent.images.map((path) => {
                  const src = imagePreview(path);
                  return src ? <img key={path} src={src} alt={path} title={path} /> : <code key={path}>{path}</code>;
                })}
              </div>
            </>
          )}
          <div className="dialog-actions">
            <button type="button" onClick={() => void copyText([sent.system, sent.prompt].filter(Boolean).join('\n\n'))}>
              Copiar
            </button>
            <button ref={cancelRef} type="button" className="primary" data-action="close" onClick={close}>
              Cerrar
            </button>
          </div>
        </div>
      </div>
    );
  }

  const creating = dialog.expected === null;
  return <InstructionsDialog key={`${dialog.dir}|${dialog.file}`} close={close} onKeyDown={onKeyDown} cancelRef={cancelRef} creating={creating} />;
}

/** AGENTS.md / CLAUDE.md before writing it: the exact text, editable; for an update, what changes. */
function InstructionsDialog({
  close,
  onKeyDown,
  cancelRef,
  creating,
}: {
  close: () => void;
  onKeyDown: (event: React.KeyboardEvent) => void;
  cancelRef: React.RefObject<HTMLButtonElement | null>;
  creating: boolean;
}) {
  const dialog = useOrchestrator((s) => (s.dialog?.kind === 'instructions' ? s.dialog : null));
  const [showDiff, setShowDiff] = useState(false);
  const diff = useMemo(() => (dialog && dialog.expected !== null && dialog.file === 'agents' ? lineDiff(dialog.expected, dialog.content) : null), [dialog?.expected, dialog?.content, dialog?.file]);
  if (!dialog) return null;
  const added = diff?.filter((d) => d.type === 'add').length ?? 0;
  const removed = diff?.filter((d) => d.type === 'del').length ?? 0;
  return (
    <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && !dialog.writing && close()}>
      <div role="dialog" aria-modal="true" aria-label={dialog.path} className="dialog orch-instructions" data-orch="instructions-dialog" data-file={dialog.file} onKeyDown={onKeyDown}>
        <h2>
          {creating ? 'Crear' : 'Modificar'} <code>{dialog.path}</code>
        </h2>
        <p>
          Este es el contenido exacto que se va a escribir en la carpeta del proyecto. Revisalo y editalo si hace falta: no se escribe nada hasta que confirmes, y Brisa nunca
          hace commit.
          {!creating && dialog.file === 'claude' && ' El archivo ya existe: solo se le agrega lo necesario, el resto queda igual.'}
          {!creating && dialog.file === 'agents' && ' Es el archivo completo actualizado: reemplaza al actual.'}
        </p>
        {diff && (
          <div className="orch-instructions-diff" data-orch="instructions-diff">
            <button type="button" className="ai-link" aria-expanded={showDiff} onClick={() => setShowDiff((v) => !v)}>
              {showDiff ? 'Ocultar los cambios' : 'Ver los cambios'}
            </button>{' '}
            <span className="orch-diff-counts">
              <span data-tone="add">+{added}</span> <span data-tone="del">−{removed}</span> líneas
            </span>
            {showDiff && (
              <pre className="orch-diff-text">
                {diff.map((d, i) => (
                  <span key={i} data-line={d.type === 'same' ? undefined : d.type}>
                    {d.type === 'add' ? '+ ' : d.type === 'del' ? '- ' : '  '}
                    {d.text}
                    {'\n'}
                  </span>
                ))}
              </pre>
            )}
          </div>
        )}
        <textarea
          className="orch-instructions-text"
          data-orch="instructions-text"
          spellCheck={false}
          value={dialog.content}
          onChange={(e) => editDialogContent(e.target.value)}
        />
        {dialog.error && (
          <div className="ai-error" role="alert">
            {dialog.error}
          </div>
        )}
        <div className="dialog-actions">
          <button ref={cancelRef} type="button" data-action="cancel" disabled={dialog.writing} onClick={close}>
            Cancelar
          </button>
          <button type="button" className="primary" data-action="orch-confirm-instructions" disabled={dialog.writing || !dialog.content.trim()} onClick={() => void confirmInstructions()}>
            {creating ? `Crear ${dialog.path}` : `Guardar ${dialog.path}`}
          </button>
        </div>
      </div>
    </div>
  );
}
