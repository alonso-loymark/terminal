import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { panesToSave, runningCommand, saveCurrentLayout } from '../lib/layoutActions';
import { folderName } from '../lib/paths';
import { focusActiveTerminal } from '../lib/tabActions';
import { findLayout } from '../store/layouts';
import { useUi } from '../store/ui';
import { useWorkspace } from '../store/workspace';
import { panesOf, prettifyTitle, tabOfPane, tabTitle, type PaneId } from '../store/workspaceModel';

const close = () => {
  useUi.getState().closeLayoutDialog();
  focusActiveTerminal();
};

/** Saving the active tab or the window as a named layout, with an optional command per pane. */
export function SaveLayoutDialog() {
  const dialog = useUi((s) => s.layoutDialog);
  if (!dialog) return null;
  return <LayoutForm scope={dialog.scope} tabId={dialog.tabId} />;
}

function LayoutForm({ scope, tabId }: { scope: 'tab' | 'window'; tabId: string | null }) {
  const target = useMemo(() => ({ scope, tabId }), [scope, tabId]);
  const panes = useMemo(() => panesToSave(target), [target]);
  const [name, setName] = useState(() => (scope === 'tab' && tabId ? tabTitle(useWorkspace.getState(), tabId, '') : ''));
  // What runs in each pane now is the likely thing to start there next time.
  const [commands, setCommands] = useState<Record<PaneId, string>>(() =>
    Object.fromEntries(panes.map((id) => [id, runningCommand(id)])),
  );
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    nameRef.current?.focus();
    nameRef.current?.select();
  }, []);

  const ws = useWorkspace.getState();
  const exists = !!name.trim() && !!findLayout(name);
  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (!name.trim()) return;
    if (saveCurrentLayout(name, target, commands)) close();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  };

  const describe = (paneId: PaneId) => {
    const tab = tabOfPane(ws, paneId);
    const pane = ws.panes[paneId];
    const index = tab ? panesOf(ws.tabs[tab]!.layout).indexOf(paneId) + 1 : 0;
    const where = pane?.cwd ?? pane?.startCwd;
    const parts = [scope === 'window' && tab ? tabTitle(ws, tab) : null, `panel ${index}`, where ? folderName(where) : prettifyTitle(pane?.title ?? '')];
    return parts.filter(Boolean).join(' · ');
  };

  return (
    <div className="dialog-backdrop">
      <form className="dialog layout-dialog" role="dialog" aria-modal="true" aria-labelledby="layout-title" onKeyDown={onKeyDown} onSubmit={submit}>
        <h2 id="layout-title">{scope === 'tab' ? 'Guardar la tab como layout' : 'Guardar la ventana como layout'}</h2>
        <label className="layout-field">
          <span>Nombre</span>
          <input
            ref={nameRef}
            name="layout-name"
            className="settings-input"
            value={name}
            placeholder="Proyecto X: Claude Code, dev server y git"
            spellCheck={false}
            onChange={(event) => setName(event.currentTarget.value)}
          />
        </label>
        {exists && <p className="layout-exists">Ya hay un layout con ese nombre: se reemplaza.</p>}
        <p>Comando inicial de cada panel (opcional): se escribe al abrir el layout, cuando la shell está lista.</p>
        <div className="layout-panes">
          {panes.map((paneId) => (
            <label key={paneId} className="layout-field">
              <span>{describe(paneId)}</span>
              <input
                className="settings-input"
                data-pane-command={paneId}
                value={commands[paneId] ?? ''}
                placeholder="sin comando"
                spellCheck={false}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  setCommands((c) => ({ ...c, [paneId]: value }));
                }}
              />
            </label>
          ))}
        </div>
        <div className="dialog-actions">
          <button type="button" data-action="cancel" onClick={close}>
            Cancelar
          </button>
          <button type="submit" className="primary" data-action="save-layout" disabled={!name.trim()}>
            {exists ? 'Reemplazar' : 'Guardar'}
          </button>
        </div>
      </form>
    </div>
  );
}
