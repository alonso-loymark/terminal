// Session and saved layouts in the settings screen.
import { useEffect, useState } from 'react';
import { openLayout } from '../../lib/layoutActions';
import { deleteLayout, openLayoutsJson } from '../../lib/layoutsSync';
import { setSetting } from '../../lib/settingsSync';
import { specPanes } from '../../store/layoutModel';
import { useLayouts } from '../../store/layouts';
import { useSettings } from '../../store/settings';
import { useUi } from '../../store/ui';
import { useWorkspace } from '../../store/workspace';
import { Field, Toggle } from './Controls';

/** "Eliminar" asks once more before acting (a layout cannot be recovered from the app). */
function DeleteButton({ name }: { name: string }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const timer = window.setTimeout(() => setArmed(false), 4000);
    return () => window.clearTimeout(timer);
  }, [armed]);
  return (
    <button
      type="button"
      className="settings-button"
      data-action={armed ? 'confirm-delete-layout' : 'delete-layout'}
      data-danger={armed || undefined}
      onClick={() => (armed ? deleteLayout(name) : setArmed(true))}
    >
      {armed ? '¿Eliminar?' : 'Eliminar'}
    </button>
  );
}

const openJson = () => void openLayoutsJson().catch((error: unknown) => console.warn('[brisa] no se pudo abrir layouts.json', error));

export function SessionSection() {
  const restore = useSettings((s) => s.settings.session.restore);
  const locked = useSettings((s) => s.status === 'invalid');
  const layouts = useLayouts((s) => s.layouts);
  const issues = useLayouts((s) => s.issues);
  const status = useLayouts((s) => s.status);
  const ui = useUi.getState();
  return (
    <section className="settings-section" aria-label="Sesión y layouts">
      <h2>Sesión y layouts</h2>
      <Field
        label="Restaurar la sesión"
        setting="session.restore"
        hint="Al abrir la app vuelven las tabs, los grupos y los paneles de la última vez, con su perfil y su carpeta (no su contenido). Si una carpeta ya no existe, se abre en la del usuario."
      >
        {(id) => <Toggle id={id} value={restore} disabled={locked} onCommit={(v) => setSetting(['session', 'restore'], v)} />}
      </Field>
      <h3>Layouts guardados</h3>
      <p className="settings-intro">
        Se abren desde la paleta (Ctrl+Shift+P) o el menú «▾». Están en layouts.json, que se puede editar a mano: cada panel puede
        tener un comando inicial, que se escribe cuando la shell está lista.
      </p>
      {status === 'invalid' && (
        <div className="settings-banner" data-severity="error" role="alert">
          <strong>layouts.json tiene errores:</strong> se siguen usando los layouts de antes, y guardar desde la app queda bloqueado hasta
          corregirlo.
        </div>
      )}
      {issues.length > 0 && (
        <ul className="settings-issues" data-layout-issues={issues.length}>
          {issues.map((issue, i) => (
            <li key={i}>
              {issue.line ? `Línea ${issue.line}: ` : ''}
              {issue.path ? `${issue.path}: ` : ''}
              {issue.message}
            </li>
          ))}
        </ul>
      )}
      {layouts.length === 0 ? (
        <p className="settings-hint">Todavía no hay layouts.</p>
      ) : (
        <ul className="layout-list">
          {layouts.map((layout) => {
            const panes = layout.tabs.reduce((n, tab) => n + specPanes(tab.layout).length, 0);
            const commands = layout.tabs.flatMap((tab) => specPanes(tab.layout)).filter((p) => p.command).length;
            return (
              <li key={layout.name} className="layout-item" data-layout={layout.name}>
                <span className="layout-name">{layout.name}</span>
                <span className="layout-summary">
                  {layout.tabs.length === 1 ? '1 tab' : `${layout.tabs.length} tabs`} · {panes === 1 ? '1 panel' : `${panes} paneles`}
                  {commands > 0 && ` · ${commands === 1 ? '1 comando' : `${commands} comandos`}`}
                </span>
                <button
                  type="button"
                  className="settings-button"
                  data-action="open-layout"
                  onClick={() => {
                    useUi.getState().closeSettings();
                    openLayout(layout.name);
                  }}
                >
                  Abrir
                </button>
                <DeleteButton name={layout.name} />
              </li>
            );
          })}
        </ul>
      )}
      <div className="profile-actions">
        <button
          type="button"
          className="settings-button"
          data-action="save-tab-layout"
          onClick={() => {
            ui.closeSettings();
            useUi.getState().openLayoutDialog({ scope: 'tab', tabId: useWorkspace.getState().activeTabId });
          }}
        >
          Guardar la tab como layout…
        </button>
        <button
          type="button"
          className="settings-button"
          data-action="save-window-layout"
          onClick={() => {
            ui.closeSettings();
            useUi.getState().openLayoutDialog({ scope: 'window', tabId: null });
          }}
        >
          Guardar la ventana como layout…
        </button>
        <button type="button" className="settings-button" data-action="open-layouts-json" onClick={openJson}>
          Abrir layouts.json
        </button>
      </div>
    </section>
  );
}
