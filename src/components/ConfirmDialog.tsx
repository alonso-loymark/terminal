import { useEffect, useRef, type KeyboardEvent } from 'react';
import { closeTabsNow, focusActiveTerminal } from '../lib/tabActions';
import { useUi } from '../store/ui';

/** Asks before closing tabs with running processes. Cancel has the focus: Enter never kills by accident. */
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
    closeTabsNow(confirm.tabIds);
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
        <h2 id="confirm-title">{confirm.title}</h2>
        <p id="confirm-message">{confirm.message}</p>
        <ul className="dialog-details">
          {confirm.details.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <div className="dialog-actions">
          <button ref={cancelRef} type="button" data-action="cancel" onClick={cancel}>
            Cancelar
          </button>
          <button ref={acceptRef} type="button" className="danger" data-action="confirm" onClick={accept}>
            {confirm.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
