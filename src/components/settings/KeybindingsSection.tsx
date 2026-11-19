// The shortcuts of the settings screen: every action with its keys, which can be removed, added
// (recording a key press) or reset; conflicts between actions and with keys programs need.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  ACTIONS,
  actionById,
  CATEGORY_LABELS,
  blocksTyping,
  conflictsFor,
  defaultKeys,
  formatKey,
  keyFromEvent,
  type ActionCategory,
  type ActionDef,
  type Conflict,
} from '../../config/keybindings';
import { reassignKey, resetKeybindings, setKeybindings } from '../../lib/settingsActions';
import { currentConflicts, useKeymap } from '../../store/keymap';
import { useSettings } from '../../store/settings';
import { useUi } from '../../store/ui';

const CATEGORIES = Object.keys(CATEGORY_LABELS) as ActionCategory[];

/** A recorded key waiting for the user to decide (it collides with something). */
interface Proposal {
  key: string;
  conflicts: Conflict[];
}

function Recorder({ action, onDone }: { action: ActionDef; onDone: () => void }) {
  const keymap = useKeymap();
  const ref = useRef<HTMLButtonElement>(null);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  // Leaving the recorder cancels it, except when it gives way to the collision question.
  const deciding = useRef(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    useUi.getState().setCapturingKeys(true);
    ref.current?.focus();
    return () => useUi.getState().setCapturingKeys(false);
  }, []);
  // While deciding about a collision the keyboard is free again (buttons, Esc).
  useEffect(() => useUi.getState().setCapturingKeys(!proposal), [proposal]);

  const assign = (key: string) => {
    const keys = keymap.bindings[action.id] ?? [];
    if (!keys.includes(key)) setKeybindings(action.id, [...keys, key]);
    onDone();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Escape' && !event.ctrlKey && !event.altKey && !event.shiftKey) return onDone();
    const key = keyFromEvent(event.nativeEvent);
    if (!key) return;
    if (action.scope !== 'explorer' && blocksTyping(key)) {
      setError(`${formatKey(key)} sin Ctrl ni Alt no se podría escribir en la terminal. Probá con un modificador.`);
      return;
    }
    setError(null);
    const conflicts = conflictsFor(keymap, action.id, key).filter((c) => c.kind !== 'typing');
    if (conflicts.length === 0) return assign(key);
    deciding.current = true;
    setProposal({ key, conflicts });
  };

  if (proposal) {
    const duplicate = proposal.conflicts.find((c) => c.kind === 'duplicate');
    const others = duplicate?.actions.filter((id) => id !== action.id).map((id) => actionById(id)?.label) ?? [];
    return (
      <div className="key-proposal" role="alert" data-key={proposal.key}>
        <span className="key-chip">{formatKey(proposal.key)}</span>
        {proposal.conflicts.map((c) => (
          <span key={c.kind} className="key-conflict-text" data-kind={c.kind}>
            {c.kind === 'duplicate' ? `Ya es el atajo de ${others.map((o) => `«${o}»`).join(' y ')}.` : c.message}
          </span>
        ))}
        {duplicate ? (
          <button
            type="button"
            className="settings-button"
            data-action="reassign-key"
            onClick={() => {
              reassignKey(action.id, proposal.key);
              onDone();
            }}
          >
            Reasignar
          </button>
        ) : (
          <button type="button" className="settings-button" data-action="assign-anyway" onClick={() => assign(proposal.key)}>
            Asignar igual
          </button>
        )}
        <button type="button" className="settings-button" data-action="cancel-key" onClick={onDone}>
          Cancelar
        </button>
      </div>
    );
  }
  return (
    <>
      <button ref={ref} type="button" className="key-recorder" data-action="record-key" onKeyDown={onKeyDown} onBlur={() => !deciding.current && onDone()}>
        Presioná la combinación… (Esc cancela)
      </button>
      {error && (
        <span className="key-conflict-text" data-kind="typing" role="alert">
          {error}
        </span>
      )}
    </>
  );
}

function ActionRow({ action, conflicts, locked }: { action: ActionDef; conflicts: Conflict[]; locked: boolean }) {
  const keymap = useKeymap();
  const [recording, setRecording] = useState(false);
  const keys = keymap.bindings[action.id] ?? [];
  const customized = keymap.customized.has(action.id);
  const severity = (key: string) => {
    const mine = conflicts.filter((c) => c.key === key && c.actions.includes(action.id));
    if (mine.some((c) => c.kind !== 'reserved')) return { kind: 'error', title: mine.map((c) => c.message).join('\n') };
    if (mine.length) return { kind: 'warning', title: mine.map((c) => c.message).join('\n') };
    return null;
  };
  return (
    <li className="key-row" data-action-id={action.id} data-customized={customized || undefined}>
      <span className="key-label">
        {action.label}
        {action.scope === 'terminal' && <span className="key-scope">en la terminal</span>}
        {action.scope === 'explorer' && <span className="key-scope">en el explorador</span>}
      </span>
      <span className="key-list">
        {keys.length === 0 && !recording && <span className="key-none">sin atajo</span>}
        {keys.map((key) => {
          const problem = severity(key);
          return (
            <span key={key} className="key-chip" data-key={key} data-conflict={problem?.kind} title={problem?.title}>
              {problem && <span aria-hidden="true">⚠ </span>}
              {formatKey(key)}
              <button
                type="button"
                className="key-remove"
                aria-label={`Quitar ${formatKey(key)}`}
                data-action="remove-key"
                disabled={locked}
                onClick={() => setKeybindings(action.id, keys.filter((k) => k !== key))}
              >
                ×
              </button>
            </span>
          );
        })}
        {recording ? (
          <Recorder action={action} onDone={() => setRecording(false)} />
        ) : (
          <button type="button" className="key-add" data-action="add-key" disabled={locked} title="Agregar un atajo" onClick={() => setRecording(true)}>
            +
          </button>
        )}
        {customized && (
          <button
            type="button"
            className="key-add"
            data-action="reset-key"
            disabled={locked}
            title={`Volver al de por defecto: ${defaultKeys(action.id).map(formatKey).join(', ') || 'sin atajo'}`}
            onClick={() => setKeybindings(action.id, defaultKeys(action.id))}
          >
            ↺
          </button>
        )}
      </span>
    </li>
  );
}

export function KeybindingsSection() {
  const keymap = useKeymap();
  const locked = useSettings((s) => s.status === 'invalid');
  const customized = useSettings((s) => Object.keys(s.settings.keybindings).length > 0);
  const [filter, setFilter] = useState('');
  const conflicts = useMemo(() => currentConflicts(), [keymap]);
  const serious = conflicts.filter((c) => c.kind !== 'reserved');
  const needle = filter.trim().toLowerCase();
  const visible = (action: ActionDef) =>
    !needle ||
    action.label.toLowerCase().includes(needle) ||
    (keymap.bindings[action.id] ?? []).some((key) => formatKey(key).toLowerCase().includes(needle) || key.includes(needle));

  return (
    <section className="settings-section" aria-label="Atajos">
      <h2>Atajos de teclado</h2>
      <p className="settings-intro">
        Se guardan en <code>keybindings</code> de settings.json (solo los que cambiaste). Los de la app ganan sobre la terminal: el
        programa ya no recibe esa tecla.
      </p>
      <div className="key-toolbar">
        <input
          type="search"
          className="settings-input"
          placeholder="Buscar una acción o una tecla"
          aria-label="Buscar atajos"
          value={filter}
          onChange={(event) => setFilter(event.currentTarget.value)}
        />
        <button type="button" className="settings-button" data-action="reset-keybindings" disabled={locked || !customized} onClick={() => resetKeybindings()}>
          Restaurar los valores por defecto
        </button>
      </div>
      {serious.length > 0 && (
        <div className="settings-banner" data-severity="error" role="alert" data-conflicts={serious.length}>
          <strong>{serious.length === 1 ? 'Un conflicto' : `${serious.length} conflictos`}:</strong>
          <ul>
            {serious.map((c) => (
              <li key={`${c.kind}:${c.key}`}>{c.message}</li>
            ))}
          </ul>
        </div>
      )}
      {CATEGORIES.map((category) => {
        const actions = ACTIONS.filter((a) => a.category === category && visible(a));
        if (actions.length === 0) return null;
        return (
          <div key={category} className="key-group">
            <h3>{CATEGORY_LABELS[category]}</h3>
            <ul className="key-rows">
              {actions.map((action) => (
                <ActionRow key={action.id} action={action} conflicts={conflicts} locked={locked} />
              ))}
            </ul>
          </div>
        );
      })}
    </section>
  );
}
