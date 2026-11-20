import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { AGENT_LABELS } from '../lib/agentMonitor';
import { gitStatus } from '../lib/fsApi';
import { openMultiAgent, type PaneChoice } from '../lib/multiAgent';
import { focusActiveTerminal } from '../lib/tabActions';
import { useUi } from '../store/ui';

const CHOICES: readonly (readonly [PaneChoice, string])[] = [
  ['claude', AGENT_LABELS.claude],
  ['codex', AGENT_LABELS.codex],
  ['gemini', AGENT_LABELS.gemini],
  ['shell', 'Solo la shell'],
];
const DEFAULTS: PaneChoice[] = ['claude', 'codex', 'gemini', 'claude'];

const close = () => {
  useUi.getState().closeMultiAgent();
  focusActiveTerminal();
};

/** "Abrir multi-agente aquí": how many panes, which agent in each, and worktrees or not. */
export function MultiAgentDialog() {
  const dialog = useUi((s) => s.multiAgent);
  if (!dialog) return null;
  return <MultiAgentForm cwd={dialog.cwd} />;
}

function MultiAgentForm({ cwd }: { cwd: string | null }) {
  const [count, setCount] = useState(2);
  const [choices, setChoices] = useState<PaneChoice[]>(DEFAULTS);
  const [worktrees, setWorktrees] = useState(false);
  /** The repository the folder is in (worktrees need one); undefined while checking. */
  const [repo, setRepo] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const firstRef = useRef<HTMLSelectElement>(null);

  useEffect(() => {
    firstRef.current?.focus();
    if (!cwd) return setRepo(null);
    let live = true;
    gitStatus(cwd)
      .then((status) => live && setRepo(status?.root ?? null))
      .catch(() => live && setRepo(null));
    return () => {
      live = false;
    };
  }, [cwd]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    const ok = await openMultiAgent({ cwd, panes: choices.slice(0, count), worktrees: worktrees && !!repo });
    setBusy(false);
    if (ok) useUi.getState().closeMultiAgent();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  };

  return (
    <div className="dialog-backdrop">
      <form className="dialog multi-agent-dialog" role="dialog" aria-modal="true" aria-labelledby="multi-agent-title" onKeyDown={onKeyDown} onSubmit={submit}>
        <h2 id="multi-agent-title">Multi-agente aquí</h2>
        <p title={cwd ?? undefined}>{cwd ? `En ${cwd}` : 'En la carpeta del usuario'}</p>
        <fieldset className="multi-agent-count">
          <legend>Paneles</legend>
          {[2, 3, 4].map((n) => (
            <label key={n}>
              <input type="radio" name="panes" value={n} checked={count === n} onChange={() => setCount(n)} />
              {n}
            </label>
          ))}
        </fieldset>
        <div className="layout-panes">
          {choices.slice(0, count).map((choice, i) => (
            <label key={i} className="layout-field">
              <span>Panel {i + 1}</span>
              <select
                ref={i === 0 ? firstRef : undefined}
                className="settings-input settings-select"
                data-pane-agent={i}
                value={choice}
                onChange={(event) => {
                  const value = event.currentTarget.value as PaneChoice;
                  setChoices((c) => c.map((old, k) => (k === i ? value : old)));
                }}
              >
                {CHOICES.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
        <label className="multi-agent-worktrees">
          <input
            type="checkbox"
            name="worktrees"
            checked={worktrees && !!repo}
            disabled={!repo}
            onChange={(event) => setWorktrees(event.currentTarget.checked)}
          />
          Un git worktree por panel (los agentes no se pisan los archivos)
        </label>
        <p className="settings-hint">
          {repo === undefined
            ? 'Buscando el repositorio…'
            : repo
              ? `Se crean junto a ${repo}, cada uno en una rama brisa/…. Al cerrar su panel se borran (si tienen cambios sin commitear, pregunta).`
              : 'Esta carpeta no está en un repositorio de git: sin worktrees.'}
        </p>
        <div className="dialog-actions">
          <button type="button" data-action="cancel" onClick={close}>
            Cancelar
          </button>
          <button type="submit" className="primary" data-action="open-multi-agent" disabled={busy}>
            {busy ? 'Creando…' : 'Abrir'}
          </button>
        </div>
      </form>
    </div>
  );
}
