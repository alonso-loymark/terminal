import { useEffect, useMemo, useState } from 'react';
import { allThemes, findTheme, type Theme } from '../../config/themes';
import { registerDropZone } from '../../lib/dropTarget';
import { deleteTheme, importThemeFiles, importThemes, selectTheme, type ImportResult } from '../../lib/settingsActions';
import { useSettings } from '../../store/settings';

const PALETTE = ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan'] as const;

/** A theme card: a small preview of the terminal and the UI colors. */
function ThemeCard({ theme, selected, locked }: { theme: Theme; selected: boolean; locked: boolean }) {
  const t = theme.terminal;
  return (
    <div className="theme-card" data-theme-id={theme.id} data-selected={selected || undefined}>
      <button
        type="button"
        className="theme-pick"
        aria-pressed={selected}
        disabled={locked}
        title={theme.builtin ? theme.label : `${theme.label} (importado)`}
        onClick={() => selectTheme(theme.id)}
      >
        <span className="theme-preview" style={{ background: t.background, color: t.foreground, borderColor: theme.ui.border }}>
          <span className="theme-chrome" style={{ background: theme.ui.chrome }}>
            <span style={{ background: theme.ui.accent }} />
          </span>
          <span className="theme-line">
            <span style={{ color: t.green }}>~</span> <span style={{ color: t.blue }}>git</span> status
          </span>
          <span className="theme-dots">
            {PALETTE.map((key) => (
              <span key={key} style={{ background: t[key] }} />
            ))}
          </span>
        </span>
        <span className="theme-name">{theme.label}</span>
      </button>
      {!theme.builtin && (
        <button type="button" className="theme-delete" title="Eliminar el tema" aria-label={`Eliminar ${theme.label}`} disabled={locked} onClick={() => deleteTheme(theme.id)}>
          ×
        </button>
      )}
    </div>
  );
}

export function ThemesSection() {
  const name = useSettings((s) => s.settings.theme);
  const custom = useSettings((s) => s.settings.themes);
  const locked = useSettings((s) => s.status === 'invalid');
  const themes = useMemo(() => allThemes(custom), [custom]);
  const current = findTheme(name, custom);
  const [text, setText] = useState('');
  const [result, setResult] = useState<ImportResult | null>(null);

  // Theme files dragged from Windows Explorer onto the import area.
  useEffect(() => registerDropZone('theme', (paths) => void importThemeFiles(paths).then(setResult)), []);

  const runImport = () => {
    const outcome = importThemes(text);
    setResult(outcome);
    if (outcome.imported.length) setText('');
  };

  return (
    <section className="settings-section" aria-label="Temas">
      <h2>Temas</h2>
      <p className="settings-intro">El tema pinta la terminal y toda la interfaz. Cada perfil puede tener el suyo (en Perfiles).</p>
      {!current && (
        <p className="settings-warning" role="status">
          No hay un tema «{name}»: se usa Oscuro.
        </p>
      )}
      <div className="theme-grid" role="group" aria-label="Elegir tema">
        {themes.map((theme) => (
          <ThemeCard key={theme.id} theme={theme} selected={current?.id === theme.id} locked={locked} />
        ))}
      </div>
      <h3>Importar</h3>
      <div className="theme-import" data-file-drop="theme">
        <textarea
          className="settings-input settings-textarea"
          aria-label="JSON del tema"
          rows={6}
          spellCheck={false}
          placeholder={'Pegá un tema en JSON o un esquema de Windows Terminal (o arrastrá el archivo .json acá):\n{ "name": "Mi tema", "background": "#1e1e2e", "foreground": "#cdd6f4", "purple": "#cba6f7", … }'}
          value={text}
          disabled={locked}
          onChange={(event) => setText(event.currentTarget.value)}
        />
        <button type="button" className="settings-button" data-action="import-theme" disabled={locked || !text.trim()} onClick={runImport}>
          Importar
        </button>
      </div>
      {result && (
        <div className="theme-import-result" role="status" data-ok={result.imported.length > 0 || undefined}>
          {result.imported.length > 0 && <div>Importado: {result.imported.join(', ')}.</div>}
          {result.issues.map((issue, i) => (
            <div key={i} data-severity={issue.severity}>
              {issue.line ? `Línea ${issue.line}: ` : ''}
              {issue.path ? `${issue.path}: ` : ''}
              {issue.message}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
