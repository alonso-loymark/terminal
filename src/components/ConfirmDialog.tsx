import { TriangleAlert } from 'lucide-react';
import { useEffect, useRef, type KeyboardEvent } from 'react';
import { trashNow } from '../lib/explorerActions';
import { forceRemoveWorktrees } from '../lib/multiAgent';
import { deleteChat } from '../lib/orchestratorActions';
import { closeTarget, focusActiveTerminal } from '../lib/tabActions';
import { useUi } from '../store/ui';

/** Asks before closing tabs or panes with running processes. Cancel has the focus: Enter never kills by accident. */
export function ConfirmDialog() {
  const confirm = useUi((s) => s.confirm);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const acceptRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (confirm) cancelRef.current?.focus();
  }, [confirm]);

  if (!confirm) return null;

  const cancel = () => {
    useUi.getState().closeConfirm();
    focusActiveTerminal();
  };
  const accept = () => {
    useUi.getState().closeConfirm();
    if (confirm.target.kind === 'trash') {
      void trashNow(confirm.target.paths);
      focusActiveTerminal();
    } else if (confirm.target.kind === 'worktrees') {
      void forceRemoveWorktrees(confirm.target.paths);
      focusActiveTerminal();
    } else if (confirm.target.kind === 'chat') {
      deleteChat(confirm.target.dir, confirm.target.chatId);
      focusActiveTerminal();
    } else {
      closeTarget(confirm.target);
    }
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      cancel();
    } else if (event.key === 'Tab') {
      // Keep the focus inside the dialog (two buttons).
      event.preventDefault();
      (document.activeElement === cancelRef.current ? acceptRef : cancelRef).current?.focus();
    }
  };

  return (
    <div className="dialog-backdrop">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-message"
        className="dialog"
        onKeyDown={onKeyDown}
      >
        <h2 id="confirm-title" className="with-icon">
          <TriangleAlert className="dialog-icon" aria-hidden="true" />
          {confirm.title}
        </h2>
        <p id="confirm-message">{confirm.message}</p>
        <ul className="dialog-details">
          {confirm.details.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <div className="dialog-actions">
          <button ref={cancelRef} type="button" data-action="cancel" onClick={cancel}>
            {confirm.cancelLabel ?? 'Cancelar'}
          </button>
          <button ref={acceptRef} type="button" className="danger" data-action="confirm" onClick={accept}>
            {confirm.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
