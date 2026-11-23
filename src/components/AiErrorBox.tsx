import { CircleAlert } from 'lucide-react';
import type { AiErrorCode } from '../lib/aiApi';
import { aiErrorInfo } from '../lib/aiErrors';
import { useUi } from '../store/ui';

/** A failed AI request: what happened, how to fix it, and the provider's own message. */
export function AiErrorBox({ code, message }: { code: AiErrorCode; message: string }) {
  const info = aiErrorInfo(code);
  const toSettings = ['disabled', 'not-installed', 'no-key', 'api-key', 'invalid'].includes(code);
  return (
    <div className="ai-error" role="alert" data-code={code}>
      <strong className="ai-error-title with-icon">
        <CircleAlert aria-hidden="true" />
        {info.title}
      </strong>
      {info.hint && <p className="ai-error-hint">{info.hint}</p>}
      {message && message !== info.title && <p className="ai-error-detail">{message}</p>}
      {toSettings && (
        <button type="button" className="ai-link" data-action="ai-open-settings" onClick={() => useUi.getState().openSettings('ai')}>
          Abrir Configuración → IA
        </button>
      )}
    </div>
  );
}
