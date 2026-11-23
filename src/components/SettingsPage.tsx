import { Bot, FolderTree, Keyboard, LayoutTemplate, Palette, Sparkles, SquareTerminal, SwatchBook, Terminal, type LucideIcon } from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { Issue } from '../config/schema';
import { openSettingsJson } from '../lib/settingsSync';
import { focusActiveTerminal } from '../lib/tabActions';
import { useSettings } from '../store/settings';
import { useUi, type SettingsSection } from '../store/ui';
import { AgentsSection } from './settings/AgentsSection';
import { AiSection } from './settings/AiSection';
import { AppearanceSection, ExplorerSection, TerminalSection } from './settings/GeneralSections';
import { KeybindingsSection } from './settings/KeybindingsSection';
import { ProfilesSection } from './settings/ProfilesSection';
import { SessionSection } from './settings/SessionSection';
import { ThemesSection } from './settings/ThemesSection';

const SECTIONS: readonly (readonly [SettingsSection, string, LucideIcon])[] = [
  ['appearance', 'Apariencia', Palette],
  ['themes', 'Temas', SwatchBook],
  ['profiles', 'Perfiles', SquareTerminal],
  ['terminal', 'Terminal', Terminal],
  ['explorer', 'Explorador', FolderTree],
  ['agents', 'Agentes y orquestador', Bot],
  ['ai', 'IA', Sparkles],
  ['keybindings', 'Atajos', Keyboard],
  ['session', 'Sesión y layouts', LayoutTemplate],
];

const describe = (issue: Issue) =>
  `${issue.line ? `Línea ${issue.line}, columna ${issue.column}: ` : ''}${issue.path ? `${issue.path}: ` : ''}${issue.message}`;

const close = () => {
  useUi.getState().closeSettings();
  focusActiveTerminal();
};

const openJson = () =>
  void openSettingsJson().catch((error: unknown) => console.warn('[brisa] no se pudo abrir settings.json', error));

/** Problems in the file: errors (the file is not applied) or warnings (it is). */
function IssuesBanner() {
  const status = useSettings((s) => s.status);
  const issues = useSettings((s) => s.issues);
  if (status === 'invalid') {
    return (
      <div className="settings-banner" role="alert" data-severity="error">
        <strong>settings.json tiene errores.</strong> Se sigue usando la última configuración válida, y los cambios desde acá
        quedan bloqueados hasta corregirlo.
        <ul>
          {issues
            .filter((issue) => issue.severity === 'error')
            .map((issue, i) => (
              <li key={i}>{describe(issue)}</li>
            ))}
        </ul>
        <button type="button" className="settings-button" onClick={openJson}>
          Abrir settings.json
        </button>
      </div>
    );
  }
  if (issues.length === 0) return null;
  return (
    <details className="settings-banner" data-severity="warning">
      <summary>
        {issues.length === 1 ? '1 aviso' : `${issues.length} avisos`} en settings.json (se ignoran; el resto se aplica)
      </summary>
      <ul>
        {issues.map((issue, i) => (
          <li key={i}>{describe(issue)}</li>
        ))}
      </ul>
    </details>
  );
}

/** Ctrl+,: the settings screen. Every change is written to settings.json and applies at once. */
export function SettingsPage() {
  const section = useUi((s) => s.settings);
  const path = useSettings((s) => s.path);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (section) ref.current?.querySelector<HTMLElement>('[aria-current="page"]')?.focus();
    // Only when it opens; moving between sections keeps the focus where the user put it.
  }, [section !== null]);

  if (!section) return null;

  return (
    <div className="settings-backdrop" onPointerDown={(event) => event.target === event.currentTarget && close()}>
      <div
        ref={ref}
        className="settings"
        role="dialog"
        aria-modal="true"
        aria-label="Configuración"
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !event.defaultPrevented) {
            event.preventDefault();
            close();
          }
        }}
      >
        <nav className="settings-nav" aria-label="Secciones">
          <h1>Configuración</h1>
          {SECTIONS.map(([id, label, Icon]) => (
            <button
              key={id}
              type="button"
              data-section={id}
              aria-current={section === id ? 'page' : undefined}
              onClick={() => useUi.getState().openSettings(id)}
            >
              <Icon aria-hidden="true" />
              {label}
            </button>
          ))}
        </nav>
        <div className="settings-main">
          <IssuesBanner />
          {section === 'appearance' && <AppearanceSection />}
          {section === 'themes' && <ThemesSection />}
          {section === 'profiles' && <ProfilesSection />}
          {section === 'terminal' && <TerminalSection />}
          {section === 'explorer' && <ExplorerSection />}
          {section === 'agents' && <AgentsSection />}
          {section === 'ai' && <AiSection />}
          {section === 'keybindings' && <KeybindingsSection />}
          {section === 'session' && <SessionSection />}
        </div>
        <footer className="settings-footer">
          <span className="settings-path" title={path ?? undefined}>
            {path ?? 'settings.json'}
          </span>
          <button type="button" className="settings-button" data-action="open-settings-json" onClick={openJson}>
            Abrir settings.json en VS Code
          </button>
          <button type="button" className="settings-button" data-action="close-settings" onClick={close}>
            Cerrar
          </button>
        </footer>
      </div>
    </div>
  );
}
