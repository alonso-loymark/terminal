// The AI settings: provider, model, where claude is, the API key (Credential Manager) and the
// user's own redaction patterns.
import { useEffect, useState } from 'react';
import { AI_MODELS } from '../../config/settingsSchema';
import { aiDeleteApiKey, aiSetApiKey, aiStatus, type AiStatus } from '../../lib/aiApi';
import { aiErrorInfo, CLAUDE_INSTALL } from '../../lib/aiErrors';
import { setSetting } from '../../lib/settingsSync';
import { useSettings } from '../../store/settings';
import { Field, Select, TextInput, Toggle } from './Controls';

const useLocked = () => useSettings((s) => s.status === 'invalid');

/** "Verificar": is claude there, which version, is there a login (no question to any model). */
function ClaudeCheck({ claudePath }: { claudePath: string }) {
  const [state, setState] = useState<{ checking: boolean; status: AiStatus | null; error: string | null }>({ checking: false, status: null, error: null });
  const check = () => {
    setState({ checking: true, status: null, error: null });
    aiStatus('claude-cli', claudePath.trim() || null)
      .then((status) => setState({ checking: false, status, error: null }))
      .catch((error: unknown) => setState({ checking: false, status: null, error: String(error) }));
  };
  const { status } = state;
  return (
    <div className="ai-check" data-part="claude-check">
      <button type="button" className="settings-button" data-action="ai-check-claude" disabled={state.checking} onClick={check}>
        {state.checking ? 'Verificando…' : 'Verificar Claude Code'}
      </button>
      {state.error && <p className="settings-hint" data-status="error">{state.error}</p>}
      {status?.error && (
        <p className="settings-hint" data-status="error">
          {aiErrorInfo(status.error.code).title} {status.error.message} {aiErrorInfo(status.error.code).hint}
        </p>
      )}
      {status?.claude && (
        <p className="settings-hint" data-status={status.claude.loggedIn === false ? 'error' : 'ok'}>
          {status.claude.version ? `Claude Code ${status.claude.version}` : 'Claude Code'} en {status.claude.path}.{' '}
          {status.claude.loggedIn === true && `Sesión iniciada${status.claude.authMethod ? ` (${status.claude.authMethod})` : ''}.`}
          {status.claude.loggedIn === false && 'Sin sesión iniciada: ejecutá «claude» en una terminal y usá /login.'}
          {status.claude.loggedIn === null && 'No se pudo saber si hay una sesión iniciada.'}
        </p>
      )}
    </div>
  );
}

/** The API key: written to the Windows Credential Manager, never shown again (only its end). */
function ApiKey() {
  const [hint, setHint] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    aiStatus('anthropic-api', null)
      .then((status) => setHint(status.apiKey))
      .catch(() => setHint(null));
  }, []);
  const save = () => {
    const key = draft.trim();
    if (!key) return;
    aiSetApiKey(key)
      .then((saved) => {
        setHint(saved);
        setDraft('');
        setMessage('Guardada en el Administrador de credenciales de Windows.');
      })
      .catch((error: unknown) => setMessage(`No se pudo guardar: ${String(error)}`));
  };
  return (
    <div className="ai-key" data-part="api-key">
      <p className="settings-hint" data-part="api-key-state">
        {hint ? `Hay una API key guardada (${hint}).` : 'No hay ninguna API key guardada.'}
      </p>
      <div className="ai-key-row">
        <input
          type="password"
          className="settings-input"
          value={draft}
          placeholder="sk-ant-…"
          aria-label="API key de Anthropic"
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') save();
          }}
        />
        <button type="button" className="settings-button" data-action="ai-save-key" disabled={!draft.trim()} onClick={save}>
          Guardar
        </button>
        {hint && (
          <button
            type="button"
            className="settings-button"
            data-action="ai-delete-key"
            data-danger=""
            onClick={() => {
              aiDeleteApiKey()
                .then(() => {
                  setHint(null);
                  setMessage('API key borrada del Administrador de credenciales.');
                })
                .catch((error: unknown) => setMessage(`No se pudo borrar: ${String(error)}`));
            }}
          >
            Borrar
          </button>
        )}
      </div>
      {message && <p className="settings-hint">{message}</p>}
    </div>
  );
}

/** One regular expression per line; an invalid one is pointed out instead of saved. */
function RedactPatterns({ value, disabled }: { value: readonly string[]; disabled: boolean }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <TextInput
        id="ai-redact"
        multiline
        value={value.join('\n')}
        placeholder={'ACME\ncliente-[a-z]+\\.local'}
        disabled={disabled}
        onCommit={(text) => {
          const patterns = text
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean);
          for (const pattern of patterns) {
            try {
              new RegExp(pattern, 'iu');
            } catch (e) {
              setError(`«${pattern}» no es una expresión regular válida: ${e instanceof Error ? e.message : String(e)}`);
              return;
            }
          }
          setError(null);
          setSetting(['ai', 'redact'], patterns);
        }}
      />
      {error && (
        <div className="settings-hint" data-status="error" role="alert">
          {error}
        </div>
      )}
    </>
  );
}

export function AiSection() {
  const settings = useSettings((s) => s.settings.ai);
  const locked = useLocked();
  return (
    <section className="settings-section" aria-label="IA">
      <h2>IA</h2>
      <p className="settings-hint">
        «Explicar / arreglar» en los bloques que fallaron, lenguaje natural a comando (Ctrl+I) y un chat corto sobre la terminal (Ctrl+Shift+I). Antes de enviar
        cualquier contexto, Brisa oculta tokens, API keys, contraseñas, connection strings, valores de variables de entorno sensibles y el contenido de archivos
        .env («Ver qué se envía» muestra exactamente qué sale). Ningún comando sugerido se ejecuta solo.
      </p>
      <Field label="IA activada" setting="ai.enabled" hint="Desactivada, Brisa no hace ninguna llamada de red ni lanza claude.">
        {(id) => <Toggle id={id} value={settings.enabled} disabled={locked} onCommit={(v) => setSetting(['ai', 'enabled'], v)} />}
      </Field>
      <Field
        label="Proveedor"
        setting="ai.provider"
        hint={
          settings.provider === 'claude-cli'
            ? 'El CLI de Claude Code (claude -p) con tu sesión: sin API key, sin herramientas, sin acceso a archivos, sin tu CLAUDE.md ni la configuración del proyecto.'
            : 'La API de Anthropic con tu API key (se cobra por uso en tu cuenta de la API).'
        }
      >
        {(id) => (
          <Select
            id={id}
            value={settings.provider}
            disabled={locked}
            options={[
              ['claude-cli', 'Claude Code (tu suscripción)'],
              ['anthropic-api', 'API de Anthropic (API key)'],
            ]}
            onCommit={(v) => setSetting(['ai', 'provider'], v)}
          />
        )}
      </Field>
      <Field label="Modelo" setting="ai.model" hint="Un alias (opus, sonnet, haiku, fable) o el id completo del modelo.">
        {(id) => <TextInput id={id} value={settings.model} disabled={locked} suggestions={AI_MODELS} onCommit={(v) => v.trim() && setSetting(['ai', 'model'], v.trim())} />}
      </Field>
      {settings.provider === 'claude-cli' ? (
        <Field
          label="Ruta de claude"
          setting="ai.claudePath"
          hint={`Vacío: se busca claude en el PATH y en las carpetas de instalación habituales. Para instalarlo: ${CLAUDE_INSTALL}`}
        >
          {(id) => (
            <>
              <TextInput id={id} value={settings.claudePath} placeholder="automático" disabled={locked} onCommit={(v) => setSetting(['ai', 'claudePath'], v.trim())} />
              {settings.enabled && <ClaudeCheck claudePath={settings.claudePath} />}
            </>
          )}
        </Field>
      ) : (
        <Field label="API key de Anthropic" hint="Se guarda en el Administrador de credenciales de Windows (nunca en settings.json ni en texto plano).">
          {() => <ApiKey />}
        </Field>
      )}
      <Field
        label="Ocultar también"
        setting="ai.redact"
        hint="Una expresión regular por línea (sin distinguir mayúsculas): nombres de clientes, dominios o servidores internos… Se aplica a todo lo que se envía."
      >
        {() => <RedactPatterns value={settings.redact} disabled={locked} />}
      </Field>
    </section>
  );
}
