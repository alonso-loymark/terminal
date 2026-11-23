// Appearance, terminal and explorer sections of the settings screen (small private pieces of
// SettingsPage).
import { setSetting } from '../../lib/settingsSync';
import { useSettings } from '../../store/settings';
import { Field, NumberInput, Range, Select, TextInput, Toggle } from './Controls';

const FONTS = [
  '"Cascadia Mono", "Cascadia Code", Consolas, "Courier New", monospace',
  '"Cascadia Code", Consolas, monospace',
  '"JetBrains Mono", Consolas, monospace',
  '"Fira Code", Consolas, monospace',
  'Consolas, "Courier New", monospace',
];

const useLocked = () => useSettings((s) => s.status === 'invalid');

export function AppearanceSection() {
  const a = useSettings((s) => s.settings.appearance);
  const restartRequired = useSettings((s) => s.restartRequired);
  const locked = useLocked();
  return (
    <section className="settings-section" aria-label="Apariencia">
      <h2>Apariencia</h2>
      <Field label="Fuente" setting="appearance.fontFamily" hint="Lista CSS: se usa la primera que esté instalada.">
        {(id) => (
          <TextInput id={id} value={a.fontFamily} suggestions={FONTS} disabled={locked} onCommit={(v) => v.trim() && setSetting(['appearance', 'fontFamily'], v.trim())} />
        )}
      </Field>
      <Field label="Tamaño" setting="appearance.fontSize" hint="Ctrl+= / Ctrl+- hacen zoom sin cambiar esto.">
        {(id) => <NumberInput id={id} value={a.fontSize} min={6} max={48} disabled={locked} onCommit={(v) => setSetting(['appearance', 'fontSize'], v)} />}
      </Field>
      <Field label="Alto de línea" setting="appearance.lineHeight">
        {(id) => (
          <NumberInput id={id} value={a.lineHeight} min={0.8} max={3} step={0.05} disabled={locked} onCommit={(v) => setSetting(['appearance', 'lineHeight'], Math.round(v * 100) / 100)} />
        )}
      </Field>
      <Field label="Ligaduras" setting="appearance.ligatures" hint="=> != -> como un solo símbolo. Requiere una fuente con ligaduras (Cascadia Code, Fira Code, JetBrains Mono).">
        {(id) => <Toggle id={id} value={a.ligatures} disabled={locked} onCommit={(v) => setSetting(['appearance', 'ligatures'], v)} />}
      </Field>
      <Field label="Cursor" setting="appearance.cursorStyle">
        {(id) => (
          <Select
            id={id}
            value={a.cursorStyle}
            disabled={locked}
            options={[
              ['bar', 'Barra'],
              ['block', 'Bloque'],
              ['underline', 'Subrayado'],
            ]}
            onCommit={(v) => setSetting(['appearance', 'cursorStyle'], v)}
          />
        )}
      </Field>
      <Field label="Cursor parpadeante" setting="appearance.cursorBlink">
        {(id) => <Toggle id={id} value={a.cursorBlink} disabled={locked} onCommit={(v) => setSetting(['appearance', 'cursorBlink'], v)} />}
      </Field>
      <Field label="Margen interno" setting="appearance.padding" hint="Píxeles alrededor de cada terminal.">
        {(id) => <NumberInput id={id} value={a.padding} min={0} max={48} disabled={locked} onCommit={(v) => setSetting(['appearance', 'padding'], v)} />}
      </Field>
      <Field
        label="Esquinas redondeadas"
        setting="appearance.cornerRadius"
        hint="Radio en px para toda la interfaz: tabs, paneles, explorador, menús y diálogos. 0 = todo cuadrado; con más de 0, los paneles y el explorador son tarjetas separadas."
      >
        {(id) => <NumberInput id={id} value={a.cornerRadius} min={0} max={16} disabled={locked} onCommit={(v) => setSetting(['appearance', 'cornerRadius'], v)} />}
      </Field>
      <Field label="Barra de título" setting="appearance.titleBar" hint="Integrada: las tabs en la misma barra que minimizar, maximizar y cerrar (como Windows Terminal). Nativa: la de Windows, encima de las tabs.">
        {(id) => (
          <Select
            id={id}
            value={a.titleBar}
            disabled={locked}
            options={[
              ['custom', 'Integrada con las tabs'],
              ['native', 'Nativa de Windows'],
            ]}
            onCommit={(v) => setSetting(['appearance', 'titleBar'], v)}
          />
        )}
      </Field>
      <Field label="Opacidad del fondo" setting="appearance.opacity">
        {(id) => <Range id={id} value={a.opacity} min={20} max={100} disabled={locked} onCommit={(v) => setSetting(['appearance', 'opacity'], v)} />}
      </Field>
      <Field
        label="Efecto de la ventana"
        setting="appearance.backdrop"
        hint={
          restartRequired ? (
            <span className="settings-restart" data-restart-required="">
              La ventana se creó opaca: la transparencia y los efectos se aplican al reiniciar la app.
            </span>
          ) : (
            'Mica y Acrylic son de Windows 11. Sin efecto ni opacidad, la ventana es opaca y no cuesta nada extra.'
          )
        }
      >
        {(id) => (
          <Select
            id={id}
            value={a.backdrop}
            disabled={locked}
            options={[
              ['none', 'Ninguno'],
              ['mica', 'Mica'],
              ['acrylic', 'Acrylic'],
            ]}
            onCommit={(v) => setSetting(['appearance', 'backdrop'], v)}
          />
        )}
      </Field>
    </section>
  );
}

export function TerminalSection() {
  const t = useSettings((s) => s.settings.terminal);
  const locked = useLocked();
  return (
    <section className="settings-section" aria-label="Terminal">
      <h2>Terminal</h2>
      <Field label="Historial" setting="terminal.scrollback" hint="Líneas que se guardan por terminal.">
        {(id) => <NumberInput id={id} value={t.scrollback} min={0} max={200_000} disabled={locked} onCommit={(v) => setSetting(['terminal', 'scrollback'], v)} />}
      </Field>
      <Field label="Copiar al seleccionar" setting="terminal.copyOnSelect" hint="Copia al portapapeles al terminar de seleccionar con el mouse.">
        {(id) => <Toggle id={id} value={t.copyOnSelect} disabled={locked} onCommit={(v) => setSetting(['terminal', 'copyOnSelect'], v)} />}
      </Field>
      <Field label="Clic derecho" setting="terminal.rightClick" hint="Shift+clic derecho siempre abre el menú.">
        {(id) => (
          <Select
            id={id}
            value={t.rightClick}
            disabled={locked}
            options={[
              ['copyPaste', 'Copiar / pegar (Windows Terminal)'],
              ['menu', 'Menú contextual (VS Code)'],
            ]}
            onCommit={(v) => setSetting(['terminal', 'rightClick'], v)}
          />
        )}
      </Field>
      <Field
        label="Pegar una imagen"
        setting="terminal.imagePaste"
        hint="Con una imagen y sin texto en el portapapeles. Las imágenes guardadas se borran solas a las pocas horas."
      >
        {(id) => (
          <Select
            id={id}
            value={t.imagePaste}
            disabled={locked}
            options={[
              ['auto', 'Automático: la tecla al agente; sin agente, la ruta'],
              ['key', 'Reenviar la tecla (el programa lee el portapapeles)'],
              ['path', 'Guardar como PNG y pegar la ruta'],
            ]}
            onCommit={(v) => setSetting(['terminal', 'imagePaste'], v)}
          />
        )}
      </Field>
    </section>
  );
}

export function ExplorerSection() {
  const e = useSettings((s) => s.settings.explorer);
  const locked = useLocked();
  return (
    <section className="settings-section" aria-label="Explorador">
      <h2>Explorador</h2>
      <Field label="Al abrir la app" setting="explorer.startup">
        {(id) => (
          <Select
            id={id}
            value={e.startup}
            disabled={locked}
            options={[
              ['remember', 'Como quedó la última vez'],
              ['visible', 'Visible'],
              ['hidden', 'Oculto'],
            ]}
            onCommit={(v) => setSetting(['explorer', 'startup'], v)}
          />
        )}
      </Field>
      <Field label="Clic en una carpeta" setting="explorer.folderClick" hint="cd solo si la shell está libre y el prompt vacío.">
        {(id) => (
          <Select
            id={id}
            value={e.folderClick}
            disabled={locked}
            options={[
              ['cd', 'Hacer cd en el panel activo'],
              ['navigate', 'Solo navegar el explorador'],
            ]}
            onCommit={(v) => setSetting(['explorer', 'folderClick'], v)}
          />
        )}
      </Field>
      <Field label="Ver ocultos" setting="explorer.showHidden" hint="node_modules, .git, lo ignorado por .gitignore y los archivos ocultos.">
        {(id) => <Toggle id={id} value={e.showHidden} disabled={locked} onCommit={(v) => setSetting(['explorer', 'showHidden'], v)} />}
      </Field>
      <Field label="Íconos de archivos" setting="explorer.fileIcons" hint="Con color: un acento sutil por tipo, con los colores del tema. Monocromo: todos en el color del texto.">
        {(id) => (
          <Select
            id={id}
            value={e.fileIcons}
            disabled={locked}
            options={[
              ['color', 'Con color'],
              ['mono', 'Monocromo'],
            ]}
            onCommit={(v) => setSetting(['explorer', 'fileIcons'], v)}
          />
        )}
      </Field>
    </section>
  );
}
