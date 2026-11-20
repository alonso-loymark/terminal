// The settings.json schema: types, defaults, validation and the JSON Schema written next to the
// file (VS Code completes and documents it). Only what differs from the defaults is written.
// Pure (tested with node --test).
import { keybindingsSchema } from './keybindings.ts';
import type { ProfileEntry } from './profiles.ts';
import {
  array,
  boolean,
  cleanJson,
  nullable,
  number,
  object,
  oneOf,
  optional,
  record,
  string,
  type Infer,
  type Issue,
  type JsonSchema,
  type Schema,
} from './schema.ts';
import { BUILTIN_THEMES, DEFAULT_THEME, themeSchema, type ThemeSpec } from './themes.ts';

/** Filled in when the JSON Schema is generated (built-in themes, detected profiles). */
const hints = { themes: [] as string[], profiles: [] as string[] };

const profileEntry: Schema<ProfileEntry> = object(
  {
    id: optional(string({ default: '', description: 'Id del perfil. El de uno detectado (pwsh, powershell, cmd, gitbash, wsl-<distro>) lo personaliza; otro id crea un perfil propio.', examples: () => hints.profiles })),
    name: optional(string({ default: '', description: 'Nombre en el menú "▾" y en la barra de estado.' })),
    icon: optional(string({ default: '', description: 'Un emoji o texto corto, o uno de: powershell, pwsh, cmd, git, linux, terminal.', examples: () => ['powershell', 'pwsh', 'cmd', 'git', 'linux', 'terminal'] })),
    command: optional(string({ default: '', description: 'Programa a ejecutar (ruta o nombre en el PATH; admite %VARIABLES%). Obligatorio en un perfil propio.' })),
    args: optional(array(string({ default: '' }), { description: 'Argumentos. Sin "args" se usan los de siempre, con integración de shell (en PowerShell también con los tuyos si no usan -Command/-File/-NoExit).' })),
    cwd: optional(string({ default: '', description: 'Carpeta inicial de las tabs nuevas con este perfil (admite %VARIABLES% y ~). Sin esto, la del panel activo.' })),
    env: optional(record(string({ default: '' }), { description: 'Variables de entorno extra (admiten %VARIABLES%).' })),
    theme: optional(string({ default: '', description: 'Tema para las terminales de este perfil (sin esto, el global).', examples: () => hints.themes })),
    hidden: optional(boolean({ default: false, description: 'Ocultarlo del menú "▾".' })),
  },
  { description: 'Un perfil: personaliza uno detectado (por id) o define uno propio.' },
) as Schema<ProfileEntry>;

const themes = themeSchema();

export const settingsSchema = object(
  {
    appearance: object(
      {
        fontFamily: string({
          default: '"Cascadia Mono", "Cascadia Code", Consolas, "Courier New", monospace',
          description: 'Fuente de la terminal (lista CSS: se usa la primera que esté instalada).',
          nonEmpty: true,
        }),
        fontSize: number({ default: 14, min: 6, max: 48, description: 'Tamaño de la fuente en px (Ctrl+= / Ctrl+- hacen zoom sin cambiar esto).' }),
        lineHeight: number({ default: 1.1, min: 0.8, max: 3, description: 'Alto de línea (múltiplo del tamaño de la fuente).' }),
        ligatures: boolean({ default: false, description: 'Ligaduras de programación (=>, !=, ->). Requiere una fuente con ligaduras, como Cascadia Code o Fira Code.' }),
        cursorStyle: oneOf(['block', 'bar', 'underline'], { default: 'bar', description: 'Forma del cursor.', labels: { block: 'Bloque', bar: 'Barra', underline: 'Subrayado' } }),
        cursorBlink: boolean({ default: true, description: 'El cursor parpadea.' }),
        padding: number({ default: 8, min: 0, max: 48, integer: true, description: 'Margen interno de cada terminal, en px.' }),
        opacity: number({ default: 100, min: 20, max: 100, integer: true, description: 'Opacidad del fondo de la terminal (%). Menos de 100 vuelve la ventana translúcida (requiere reiniciar la app la primera vez).' }),
        backdrop: oneOf(['none', 'mica', 'acrylic'], {
          default: 'none',
          description: 'Efecto de Windows detrás de la ventana (Windows 11). Activarlo por primera vez requiere reiniciar la app.',
          labels: { none: 'Ninguno', mica: 'Mica', acrylic: 'Acrylic' },
        }),
      },
      { description: 'Fuente, cursor, márgenes y transparencia.' },
    ),
    theme: string({ default: DEFAULT_THEME, description: 'Tema de la terminal y de toda la interfaz: uno incluido o el "name" de uno de "themes".', examples: () => hints.themes }),
    themes: array(themes, { description: 'Temas propios o importados (formato propio o esquema de Windows Terminal).' }) as Schema<(ThemeSpec | null)[]>,
    terminal: object(
      {
        scrollback: number({ default: 10_000, min: 0, max: 200_000, integer: true, description: 'Líneas de historial por terminal.' }),
        copyOnSelect: boolean({ default: false, description: 'Copiar al portapapeles al terminar de seleccionar con el mouse.' }),
        rightClick: oneOf(['copyPaste', 'menu'], {
          default: 'copyPaste',
          description: 'Clic derecho: copiar la selección o pegar (Windows Terminal), o un menú contextual (VS Code).',
          labels: { copyPaste: 'Copiar / pegar', menu: 'Menú contextual' },
        }),
      },
      { description: 'Comportamiento de las terminales.' },
    ),
    explorer: object(
      {
        startup: oneOf(['remember', 'visible', 'hidden'], {
          default: 'remember',
          description: 'Al abrir la app: como quedó la última vez, siempre visible u oculto.',
          labels: { remember: 'Como quedó', visible: 'Visible', hidden: 'Oculto' },
        }),
        visible: boolean({ default: true, description: 'Visible la última vez (lo actualiza Ctrl+B).' }),
        width: number({ default: 260, min: 160, max: 2000, integer: true, description: 'Ancho en px (lo actualiza arrastrar el borde).' }),
        showHidden: boolean({ default: false, description: 'Mostrar node_modules, .git, lo ignorado por .gitignore y los archivos ocultos.' }),
        folderClick: oneOf(['cd', 'navigate'], {
          default: 'cd',
          description: 'Clic en una carpeta: "cd" en el panel activo (si la shell está libre) o solo navegar el explorador.',
          labels: { cd: 'Hacer cd', navigate: 'Solo navegar' },
        }),
      },
      { description: 'El explorador de archivos (Ctrl+B).' },
    ),
    profiles: object(
      {
        default: nullable(string({ default: '', examples: () => hints.profiles }), 'Perfil de las tabs nuevas (Ctrl+Shift+T). Sin esto: PowerShell 7 si está instalado, si no Windows PowerShell.'),
        list: array(profileEntry, { description: 'Perfiles detectados personalizados y perfiles propios.' }),
      },
      { description: 'Perfiles de shell.' },
    ),
    session: object(
      {
        restore: boolean({
          default: true,
          description: 'Al abrir la app, restaurar las tabs, los grupos y los paneles de la última vez (con su perfil y su carpeta). Sin esto, no se guarda la sesión.',
        }),
      },
      { description: 'Sesión: lo que se restaura al abrir la app.' },
    ),
    blocks: object(
      {
        enabled: boolean({
          default: true,
          description: 'Bloques de comandos (con la integración de shell): una marca al costado de cada comando con su salida, roja si falló, un menú para copiar o volver a ejecutar, y Ctrl+↑ / Ctrl+↓ para saltar entre ellos.',
        }),
      },
      { description: 'Bloques de comandos.' },
    ),
    agents: object(
      {
        enabled: boolean({
          default: true,
          description: 'Detectar claude, codex y gemini en los paneles: indicador en la tab y en el panel (trabajando, esperando tu respuesta, terminado) y el preset multi-agente.',
        }),
        idleSeconds: number({
          default: 6,
          min: 2,
          max: 600,
          integer: true,
          description: 'Segundos sin salida de un agente para considerar que espera tu respuesta (si no lo avisó antes con una campana o una notificación).',
        }),
        commands: object(
          {
            claude: string({ default: 'claude', nonEmpty: true, description: 'Comando de Claude Code (con sus argumentos).' }),
            codex: string({ default: 'codex', nonEmpty: true, description: 'Comando de Codex (con sus argumentos).' }),
            gemini: string({ default: 'gemini', nonEmpty: true, description: 'Comando de Gemini CLI (con sus argumentos).' }),
          },
          { description: 'Lo que el preset multi-agente escribe en cada panel.' },
        ),
      },
      { description: 'Agentes de IA en la terminal.' },
    ),
    notifications: object(
      {
        enabled: boolean({
          default: true,
          description: 'Notificaciones de Windows cuando un panel que no está a la vista (otra tab, otro panel maximizado, la ventana minimizada o sin foco) pide atención. Clic: Brisa al frente con ese panel.',
        }),
        bell: boolean({ default: true, description: 'Una campana (BEL) cuenta como pedido de atención.' }),
        agents: boolean({ default: true, description: 'Avisar cuando un agente espera tu respuesta o termina.' }),
      },
      { description: 'Notificaciones nativas (OSC 9, OSC 777, BEL y agentes).' },
    ),
    keybindings: keybindingsSchema(),
  },
  { description: 'Configuración de Brisa. Ctrl+, abre la pantalla de configuración.' },
);

type RawSettings = Infer<typeof settingsSchema>;
/** Validated settings (broken themes dropped). */
export type Settings = Omit<RawSettings, 'themes'> & { themes: ThemeSpec[] };

export const DEFAULT_SETTINGS: Settings = { ...settingsSchema.default, themes: [] };

export interface Validation {
  /** Null when there are errors: the app keeps the last valid settings. */
  settings: Settings | null;
  issues: Issue[];
}

export function validateSettings(value: unknown): Validation {
  const issues: Issue[] = [];
  const raw = settingsSchema.parse(value, '', issues);
  if (issues.some((issue) => issue.severity === 'error')) return { settings: null, issues };
  return { settings: { ...raw, themes: raw.themes.filter((t): t is ThemeSpec => t !== null) }, issues };
}

/** The JSON Schema for settings.schema.json, with the theme and profile names as suggestions. */
export function settingsJsonSchema(profileIds: readonly string[], themeNames: readonly string[] = []): JsonSchema {
  hints.themes = [...new Set([...BUILTIN_THEMES.map((t) => t.id), ...themeNames])];
  hints.profiles = [...profileIds];
  const schema = settingsSchema.json();
  const properties = (schema.properties ?? {}) as Record<string, unknown>;
  return cleanJson({
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: 'Brisa: settings.json',
    ...schema,
    properties: { $schema: { type: 'string' }, ...properties },
    allowComments: true,
    allowTrailingCommas: true,
  });
}
