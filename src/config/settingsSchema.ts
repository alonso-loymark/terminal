// The settings.json schema: types, defaults, validation and the JSON Schema written next to the
// file (VS Code completes and documents it). Only what differs from the defaults is written.
// Pure (tested with node --test).
import { keybindingsSchema } from './keybindings.ts';
import type { ProfileEntry } from './profiles.ts';
import {
  array,
  boolean,
  cleanJson,
  custom,
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
    name: optional(string({ default: '', description: 'Nombre en el menú de perfiles (la flecha junto al +) y en la barra de estado.' })),
    icon: optional(string({ default: '', description: 'Un emoji o texto corto, o uno de: powershell, pwsh, cmd, git, linux, terminal.', examples: () => ['powershell', 'pwsh', 'cmd', 'git', 'linux', 'terminal'] })),
    command: optional(string({ default: '', description: 'Programa a ejecutar (ruta o nombre en el PATH; admite %VARIABLES%). Obligatorio en un perfil propio.' })),
    args: optional(array(string({ default: '' }), { description: 'Argumentos. Sin "args" se usan los de siempre, con integración de shell (en PowerShell también con los tuyos si no usan -Command/-File/-NoExit).' })),
    cwd: optional(string({ default: '', description: 'Carpeta inicial de las tabs nuevas con este perfil (admite %VARIABLES% y ~). Sin esto, la del panel activo.' })),
    env: optional(record(string({ default: '' }), { description: 'Variables de entorno extra (admiten %VARIABLES%).' })),
    theme: optional(string({ default: '', description: 'Tema para las terminales de este perfil (sin esto, el global).', examples: () => hints.themes })),
    hidden: optional(boolean({ default: false, description: 'Ocultarlo del menú de perfiles.' })),
  },
  { description: 'Un perfil: personaliza uno detectado (por id) o define uno propio.' },
) as Schema<ProfileEntry>;

const themes = themeSchema();

/** A regular expression (case-insensitive) the AI layer hides before sending anything. */
const redactPattern: Schema<string> = custom({
  default: '',
  parse(value, path, issues) {
    if (typeof value !== 'string' || value.trim() === '') {
      issues.push({ path, message: 'tiene que ser texto (una expresión regular)', severity: 'error' });
      return '';
    }
    try {
      new RegExp(value, 'iu');
      return value;
    } catch (error) {
      issues.push({ path, message: `expresión regular inválida: ${error instanceof Error ? error.message : String(error)}`, severity: 'error' });
      return '';
    }
  },
  json: () => ({ type: 'string', description: 'Expresión regular (sin distinguir mayúsculas). Ejemplos: "ACME", "\\bcliente-[a-z]+\\.local\\b".' }),
});

const INTERPRETERS = new Set(['sh', 'bash', 'zsh', 'cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe', 'node', 'python', 'python3', 'py', 'npx', 'bunx', 'pnpx', 'deno', 'ruby', 'perl', 'env', 'sudo', 'xargs', 'eval', 'exec']);

/**
 * Why a command pattern cannot be an allowed command of the orchestrator's workers (null: it
 * can). Mirrors `validate_pattern` in src-tauri/src/agents/permissions.rs, which has the last
 * word: one line, no rule syntax, a plain program name first, never `<interpreter> *`.
 */
export function commandPatternIssue(pattern: string): string | null {
  const p = pattern.trim();
  if (!p || p.length > 300) return 'vacío o demasiado largo';
  if ([...p].some((c) => c.charCodeAt(0) < 32)) return 'tiene saltos de línea o caracteres de control';
  if (/[()]/.test(p)) return 'no puede tener paréntesis';
  if (p.includes('%')) return 'no puede tener %';
  const [program = '', ...rest] = p.split(/\s+/);
  if (!/^[A-Za-z0-9._\-/\\:@]+$/.test(program)) return `«${program}» no es un nombre de programa`;
  if (rest.length > 0 && rest.every((w) => /^\*+$/.test(w)) && INTERPRETERS.has(program.toLowerCase())) return `«${p}» permitiría ejecutar cualquier cosa`;
  return null;
}

const commandPattern: Schema<string> = custom({
  default: '',
  parse(value, path, issues) {
    const issue = typeof value === 'string' ? commandPatternIssue(value) : 'tiene que ser texto';
    if (issue) {
      issues.push({ path, message: issue, severity: 'error' });
      return '';
    }
    return (value as string).trim();
  },
  json: () => ({ type: 'string', description: 'Un comando (con * = cualquier texto). Ejemplos: "npm run e2e *", "docker compose build *".' }),
});

/** Model aliases offered in VS Code and in the settings screen (any full model id works too). */
export const AI_MODELS = ['opus', 'sonnet', 'haiku', 'fable'] as const;

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
        cornerRadius: number({
          default: 8,
          min: 0,
          max: 16,
          integer: true,
          description: 'Radio de las esquinas de toda la interfaz en px: tabs, paneles, explorador, menús, diálogos… 0 = todo cuadrado; mayor que 0, los paneles y el explorador se ven como tarjetas separadas.',
        }),
        titleBar: oneOf(['custom', 'native'], {
          default: 'custom',
          description: 'Barra de título: las tabs en la misma barra que minimizar, maximizar y cerrar (como Windows Terminal), o la barra nativa de Windows encima de las tabs.',
          labels: { custom: 'Integrada con las tabs', native: 'Nativa de Windows' },
        }),
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
        imagePaste: oneOf(['auto', 'key', 'path'], {
          default: 'auto',
          description:
            'Pegar con una imagen (y sin texto) en el portapapeles: "auto" le reenvía la tecla al agente de IA que corre en el panel (Claude Code: Alt+V; Codex, Gemini y agy: Ctrl+V) para que lea el portapapeles, y sin agente guarda la imagen como PNG y pega su ruta; "key" siempre reenvía la tecla (Ctrl+V cruda si no hay agente); "path" siempre pega la ruta.',
          labels: { auto: 'Automático', key: 'Reenviar la tecla', path: 'Pegar la ruta' },
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
        fileIcons: oneOf(['color', 'mono'], {
          default: 'color',
          description: 'Íconos de archivos y carpetas: "color" (un acento sutil por tipo, con los colores del tema) o "mono" (todos en el color del texto).',
          labels: { color: 'Con color', mono: 'Monocromo' },
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
    ai: object(
      {
        enabled: boolean({
          default: true,
          description: 'La IA de Brisa: "Explicar / arreglar" en los bloques que fallaron, lenguaje natural a comando (Ctrl+I) y el panel de IA (Ctrl+Shift+I). Con false, Brisa no hace ninguna llamada de red ni lanza claude.',
        }),
        provider: oneOf(['claude-cli', 'anthropic-api'], {
          default: 'claude-cli',
          description: 'claude-cli: el CLI de Claude Code (claude -p) con tu sesión (suscripción), sin API key, sin herramientas ni acceso a archivos. anthropic-api: la API de Anthropic con una API key guardada en el Administrador de credenciales de Windows.',
          labels: { 'claude-cli': 'Claude Code (tu suscripción)', 'anthropic-api': 'API de Anthropic (API key)' },
        }),
        model: string({
          default: 'opus',
          nonEmpty: true,
          description: 'Modelo: un alias (opus, sonnet, haiku, fable) o el id completo (claude-opus-5-5…).',
          examples: () => [...AI_MODELS, 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
        }),
        claudePath: string({
          default: '',
          description: 'Ruta de claude.exe o claude.cmd (admite %VARIABLES%). Vacío: se busca en el PATH y en las carpetas de instalación habituales.',
        }),
        redact: array(redactPattern, {
          description: 'Más cosas a ocultar antes de enviar cualquier contexto, además de los secretos que Brisa reconoce sola (tokens, API keys, contraseñas, connection strings, .env): nombres de clientes, dominios internos…',
        }),
      },
      { description: 'IA: proveedor, modelo y qué se oculta antes de enviar.' },
    ),
    orchestrator: object(
      {
        enabled: boolean({
          default: true,
          description: 'El modo orquestador: tabs "Orquestador" con un chat por proyecto que decide qué agente, modelo y esfuerzo usar y ejecuta cada tarea con Claude Code (claude -p, tu suscripción) en la carpeta del proyecto. Con false no se lanza nada.',
        }),
        mainModel: string({
          default: 'sonnet',
          nonEmpty: true,
          description: 'Modelo principal (el que arma el plan de cada mensaje): un alias de los que ofrece Claude Code (sonnet = costo medio). Cada proyecto puede elegir otro en su selector.',
          examples: () => [...AI_MODELS],
        }),
        autoApprove: boolean({
          default: false,
          description: 'Ejecutar el plan sin pedir aprobación (el plan se muestra igual). Con false, cada plan espera "Aprobar".',
        }),
        allowedCommands: array(commandPattern, {
          description: 'Comandos que los trabajadores pueden ejecutar además de los que Brisa detecta en el proyecto (build, tests y lint de package.json, Cargo.toml, go.mod, .NET, pytest, Makefile…) y de git en solo lectura. Todo lo demás se deniega y se te pregunta.',
        }),
        maxTurns: number({
          default: 80,
          min: 5,
          max: 400,
          integer: true,
          description: 'Máximo de turnos de un trabajador por tarea (un tope para que una tarea no siga indefinidamente).',
        }),
      },
      { description: 'Modo orquestador: un chat por proyecto que delega cada tarea en un agente (Claude Code) con el modelo adecuado.' },
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
