import { Info, TriangleAlert } from 'lucide-react';
import { useEffect } from 'react';
import { useUi } from '../store/ui';

const VISIBLE_MS = 6000;

/** A short message at the bottom (a layout saved, a command that could not be typed). */
export function Toast() {
  const toast = useUi((s) => s.toast);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => {
      if (useUi.getState().toast?.id === toast.id) useUi.getState().dismissToast();
    }, VISIBLE_MS);
    return () => window.clearTimeout(timer);
  }, [toast]);
  if (!toast) return null;
  return (
    <div className="toast" role="status" data-kind={toast.kind} onClick={() => useUi.getState().dismissToast()}>
      {toast.kind === 'warning' ? <TriangleAlert className="toast-icon" aria-hidden="true" /> : <Info className="toast-icon" aria-hidden="true" />}
      <span>{toast.message}</span>
    </div>
  );
}
