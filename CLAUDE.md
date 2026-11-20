# Brisa — guía del proyecto

**Brisa** es una terminal de escritorio para Windows, liviana y muy personalizable, pensada para
trabajar con agentes de IA (Claude Code, Codex, Gemini CLI). Objetivo explícito: ser **mucho más
liviana que Warp** (binario chico, poca RAM, arranque rápido). Cada dependencia nueva tiene que
justificarse. (Hasta la Fase 6A se llamó "Terminal": el repo y la carpeta siguen con ese nombre;
ejecutable `brisa.exe`, identificador `dev.brisa.desktop`.)

## Stack (obligatorio — no cambiar sin discutirlo antes)

| Capa | Tecnología |
|---|---|
| Shell de la app | **Tauri 2** (crates `tauri` 2.x; nada de Tauri 3 alpha) — backend Rust, frontend en WebView2 |
| Frontend | **React + TypeScript + Vite** |
| Emulador | **@xterm/xterm** + `@xterm/addon-fit`, `@xterm/addon-webgl` (con fallback al renderer DOM), `@xterm/addon-web-links`, `@xterm/addon-search` |
| PTY | **portable-pty** (ConPTY en Windows) |
| Estado frontend | **zustand** |
| Drag & drop de tabs | **@dnd-kit** (`core` 6, `sortable` 10, `utilities` 3; la API estable, no `@dnd-kit/react` 0.x) |
| Explorador (Rust) | **notify** 8 (watcher), **ignore** 0.4 (`.gitignore`); git por la CLI `git` (sin libgit2) |
| Configuración | `settings.json` y `layouts.json` (JSONC) leídos con **jsonc-parser** 3 (el de VS Code: comentarios, errores con posición y ediciones que conservan el formato del usuario); validación con un esquema propio en TS (`config/schema.ts`); `session.json` (JSON que escribe la app) |
| Notificaciones | **windows** 0.62 (WinRT `ToastNotification`), solo con las features de toasts; ya estaba en el árbol por WebView2 (`webview2-com`), misma versión. Win32 sigue con `windows-sys` |
| IA | El CLI de Claude Code (`claude -p`, la suscripción del usuario) o la API de Anthropic por **WinHTTP** (`windows-sys`, feature `Win32_Networking_WinHttp`: parte de Windows, sin crate HTTP); la API key en el **Administrador de credenciales** (`Win32_Security_Credentials`). Sin dependencias nuevas |

## Arquitectura

**Rust maneja los procesos; React solo renderiza y reenvía input.** Ninguna lógica de procesos
vive en el frontend.

```
 React / WebView2                                   Rust (proceso Tauri)
 ────────────────                                   ────────────────────
 TerminalSession ── invoke create_session ────────► commands.rs ─► PtyManager::create
   (lib/terminalSession.ts)  {cols, rows, cwd, shell,                 │ abre ConPTY, lanza la shell
                              onData: Channel,                        │ (con shell integration),
                              onExit: Channel}                        │ la mete en un Job Object
                                                                      ▼
 xterm.onData ─► InputQueue ─ invoke write_to_session ─► mpsc ──► hilo writer ──► stdin del PTY
                 (un envío a la vez, en orden, reintenta; nunca descarta)
 ResizeObserver+fit ─ invoke resize_session ──────► MasterPty::resize (ResizePseudoConsole)
 term.write(bytes) ◄─ Channel onData (bytes crudos) ◄─ hilo flusher ◄─ mpsc ◄─ hilo reader ◄─ salida PTY
                         (lotes de ≤5 ms / ≤256 KB)
 mensaje de salida ◄─ Channel onExit (JSON) ◄────── flusher, después del EOF ◄─ hilo waiter (child.wait)
```

Reglas de la arquitectura:

- **IPC por Tauri Channels por sesión, nunca eventos globales (`emit`/`listen`).** La salida viaja
  como bytes crudos (`InvokeResponseBody::Raw` → `ArrayBuffer`); Rust no decodifica UTF-8, xterm
  maneja las secuencias multibyte partidas entre lotes.
- **Entrada (lo que tipea el usuario)**: `lib/inputQueue.ts`, una cola por sesión. Un solo
  `write_to_session` en vuelo a la vez (cada `invoke` es un request independiente: sin cola, el
  orden no estaba garantizado y un error se descartaba), lo que llega mientras tanto se junta en
  el próximo envío, y un envío que falla se reintenta en su lugar (10 ms … 1 s). Antes de que la
  sesión exista (respuesta al `ESC[6n` de ConPTY) espera; Shift+Enter es un elemento más de la
  misma cola, así conserva su lugar. Solo se descarta lo que ya no tiene destino: si el proceso
  terminó, la cola se vacía (con la sesión terminada, solo `Enter` hace algo: reinicia).
- **Batching**: el hilo flusher junta todo lo que llega en una ventana de 5 ms (o hasta 256 KB) y
  manda un solo mensaje. Constantes en `src-tauri/src/pty/session.rs`.
- **Hilos por sesión** (stack chico, nombrados `pty-<id>-*`): `reader` (lee el PTY), `flusher`
  (agrupa y envía), `writer` (escribe el input sin bloquear al IPC), `waiter` (espera al hijo).
- **Ciclo de vida / nada de zombies**:
  - Cada shell entra en un **Job Object** (`pty/job.rs`) que registra todo su árbol, incluidos
    nietos con consola oculta (servidores MCP, dev servers). Al cerrar una sesión de forma ordenada
    el **cierre es selectivo** (`pty/teardown.rs`):
    - **mueren** la shell y todo lo de consola (node, dev servers, agentes) y los procesos GUI
      *sin* ventana visible (browsers headless);
    - **sobreviven** los procesos dueños de una ventana visible y sus descendientes (`code .`,
      `notepad`, `charmap`…): se desarma `KILL_ON_JOB_CLOSE` antes de cerrar el handle;
    - cada kill verifica `IsProcessInJob` para no matar un proceso ajeno que reusó el PID.
  - Si la app **crashea**, `KILL_ON_JOB_CLOSE` sigue armado y el SO mata el árbol completo,
    incluidas las apps con ventana. Decisión deliberada: cero zombies antes que conservar ventanas.
  - Límites conocidos: una app que todavía no mostró su ventana (o vive solo en la bandeja) cuenta
    como proceso de fondo; las ventanas de consola nuevas (`start cmd`) son consola y mueren.
    Los procesos que piden `CREATE_BREAKAWAY_FROM_JOB` pueden salir del job (`BREAKAWAY_OK`).
  - Descartado: breakaway del job (los lanzadores no lo piden; `SILENT_BREAKAWAY_OK` vuelve a dejar
    zombies) y "subsistema GUI" (un proceso no sale de un job y GUI ≠ tener ventana).
  - Cuando el hijo termina solo, el waiter guarda el código de salida y desmonta la sesión. Esto
    cierra el pseudoconsole: **ConPTY no da EOF al reader mientras el HPCON siga abierto**.
  - El flusher manda `onExit` recién después del EOF, así el mensaje de salida nunca se adelanta
    a la última salida de la shell.
  - Las sesiones pertenecen a un webview (label). Cerrar la ventana (`WindowEvent::Destroyed`),
    recargar la página (`on_page_load` Started) o salir de la app (`RunEvent::Exit`) cierra las
    sesiones de ese dueño.
- **Ids de sesión**: `u32` incremental asignado por `PtyManager` (único dentro del proceso).
- **Comandos Tauri**: `create_session` (`{ cols, rows, cwd, shell: ShellSpec | null }`;
  devuelve `{ sessionId, shell, integration: 'full' | 'cwd' | 'none' | 'missing' }`, ver
  "Perfiles"), `write_to_session`, `resize_session`, `close_session`, `send_shift_enter` (ver
  abajo), `session_busy`, `system_info` (`{ homeDir, shells }`: las shells detectadas, una vez al
  arrancar) y `pty_backend` (devuelve `{ backend: "conpty", buildNumber }` para la opción
  `windowsPty` de xterm, que con build ≥ 21376 activa el reflow compatible con ConPTY).
  Explorador (`explorer_commands.rs`): `list_dir`, `watch_start` / `watch_set` / `watch_stop`,
  `git_status`, `create_entry`, `rename_entry`, `trash_entries`, `open_in_vscode`,
  `open_in_file_manager`. Archivos de configuración (`settings_commands.rs`): `settings_load`
  (texto de settings.json + carpeta + si la ventana se creó transparente), `config_read`,
  `config_write` (atómica; `onlyIfChanged` para los schemas) y `config_open` (VS Code), que
  reciben `file: 'settings' | 'settingsSchema' | 'session' | 'layouts' | 'layoutsSchema'`
  (`settings::ConfigFile`: el frontend nunca pasa rutas), `read_theme_file` y `set_window_look`.
  Agentes y notificaciones: `session_agents` (qué agente corre en cada sesión, una sola foto de
  la tabla de procesos), `notifications_listen` (canal por el que llegan los clics),
  `notify` y, solo en desarrollo, `debug_notification_click` / `debug_notification_history`.
  Barra de título (`titlebar.rs`): `titlebar_listen` (canal: hover y presionado de los botones),
  `titlebar_buttons` (dónde están, en px físicos; `null` = ninguno) y `set_title_bar`.
  Worktrees (`explorer_commands.rs` → `worktree.rs`): `worktree_create`, `worktree_status`,
  `worktree_remove` (solo los que Brisa registró) y `worktree_list`.
  IA (`ai_commands.rs` → `ai/`): `ai_configure` (el frontend avisa `ai.enabled`; apagada, el
  resto se niega a lanzar nada), `ai_query` (canal por consulta: deltas, después `done` o
  `error`), `ai_cancel`, `ai_status`, `ai_set_api_key` / `ai_delete_api_key` y `ai_scrub_env`.
- **Shift+Enter** (`pty/agents.rs`): el frontend no lo envía como CR; llama a `send_shift_enter` y
  Rust mira el árbol de procesos de la sesión. Si corre un agente de IA le manda *su* secuencia de
  salto de línea (la que instala su `/terminal-setup` en VS Code); si no, un Shift+Enter real en
  win32-input-mode. Ninguna secuencia única sirve para todo (verificado a través de ConPTY):

  | Programa | Detección | Se envía | Resultado |
  |---|---|---|---|
  | Claude Code | `claude.exe` o node/bun con `@anthropic-ai/claude-code` | `ESC CR` | salto de línea |
  | Gemini CLI | `gemini.exe` o node/bun con `@google/gemini-cli` | `\` CR LF | salto de línea |
  | PowerShell y el resto | — | Shift+Enter nativo | PSReadLine: AddLine (`>>`); vim/nano: como en Windows Terminal |

  `ESC CR` en PSReadLine no hace nada y el Shift+Enter nativo le llega a un TUI de Node como CR
  (enviaría el prompt): por eso la decisión es por contexto. Codex se detecta (`codex.exe`,
  `codex-<plataforma>.exe` o node con `@openai/codex`, para los indicadores) pero no tiene
  secuencia propia: usa crossterm, que lee eventos de teclado nativos, así que recibe el
  Shift+Enter nativo como en Windows Terminal (no verificado: no hay codex instalado y no se
  prueban agentes reales). El pedido viaja por la misma cola que las teclas (`InputQueue`), así
  no se reordena con ellas.
- Antes de lanzar cada shell se limpia el flag heredable "ignorar Ctrl+C" del proceso
  (`SetConsoleCtrlHandler(NULL, FALSE)`, ver Gotchas).
- `session_busy` devuelve lo que cerrar una sesión **mataría** además de la shell (misma lógica que
  el cierre selectivo: las apps con ventana no cuentan; `conhost` tampoco). Lo usa la confirmación
  de cierre de tabs.

## Tabs, grupos y panes

- **Modelo** (`store/workspaceModel.ts`, puro y sin imports en runtime → se testea con
  `node --test`): `tabs`, `tabOrder`, `groups`, `panes`, `activeTabId`. Cada **Tab** tiene un
  `layout`, `activePaneId` y `zoomedPaneId`. Cada **Pane** (mapa global, no anidado en tabs) guarda
  la metadata de su sesión: `sessionId` del backend, título OSC, estado, código de salida, actividad.
- **Grupos estilo Chrome**: un grupo es un tramo **contiguo** de `tabOrder` con el mismo `groupId`.
  `normalize()` restaura la contigüidad y borra grupos vacíos después de cada cambio.
- **Arrastre** (`moveTab`): soltar *estrictamente entre* dos tabs de un grupo la mete; en el borde
  de su propio grupo, se queda; si es la única tab del grupo, el grupo se mueve con ella; en
  cualquier otro lado, sale. Soltar *sobre el chip* la agrega al final del grupo (la colisión
  prefiere el chip solo si el puntero está encima).
- **La tab activa nunca queda oculta**: colapsar un grupo que la contiene activa la tab visible más
  cercana afuera (si no hay, no colapsa); activar una tab de un grupo colapsado lo expande.
  `Ctrl+Tab` salta las tabs colapsadas.
- **Terminales siempre montadas y planas**: `Workspace` renderiza un `TerminalPane` por pane, en
  orden de creación y **fuera del árbol**: el layout solo decide el rectángulo de cada uno
  (`layoutRects` → `left/top/width/height` en %, ver `lib/paneGeometry.ts`). Dividir, cerrar,
  arrastrar divisores, hacer zoom o cambiar de tab solo cambia estilos: **nunca se recrea una
  instancia xterm**. Las ocultas usan `display: none` (xterm pausa el render y conserva scrollback
  y modos); al mostrarse, `fit()` + foco al panel activo. Instancias en `lib/terminalRegistry.ts`.
- **Por qué no `react-resizable-panels`**: renderiza el contenido de cada panel como hijo de su
  `PanelGroup`; al dividir o cerrar, el contenido cambia de padre y React lo desmonta (se
  recrearía xterm). Los divisores propios (`PaneDivider`) escriben tamaños en el store, que es la
  única fuente de verdad. Una dependencia menos.
- **Resize → PTY**: cada `TerminalPane` tiene un `ResizeObserver`; cualquier cambio de tamaño
  (ventana, split, divisor, zoom) hace `fit()`, que dispara `resize_session` con las nuevas
  columnas/filas. Verificado en e2e midiendo `[Console]::WindowWidth` dentro de cada panel.
- **WebGL solo en lo visible** (`lib/renderer.ts`, `GpuRenderer`): al ocultarse una terminal
  (otra tab, o fuera del zoom) suelta su contexto WebGL y queda con el renderer DOM; al mostrarse
  lo recrea (fallback al DOM si falla). `dispose()` del addon no libera el contexto en Chromium
  hasta el GC: hay que llamar `WEBGL_lose_context.loseContext()`; sin eso, tras ~16 ciclos aparece
  "Too many active WebGL contexts" (verificado en e2e con 18 terminales).
- **Cerrar** (`lib/tabActions.ts`): `requestClosePane` / `requestCloseTabs` consultan
  `session_busy`; si hay algo más que la shell, se pide confirmación (foco en *Cancelar*).
  Desmontar el pane cierra la sesión con el cierre selectivo. Cerrar la última tab cierra la ventana.
- **Duplicar** abre una shell nueva con el mismo nombre, color, grupo, shell y carpeta (la que
  reportó la *shell integration*; ver abajo). Nueva tab y dividir también abren en la carpeta del
  panel activo.
- **Actividad**: la salida de un pane que **no está en pantalla** (otra tab, o fuera del zoom) lo
  marca; la tab muestra el punto si cualquiera de sus panes tiene marca. Mostrarlo la limpia.
  Proceso terminado: anillo gris (código 0) o rojo (error), también por cualquier panel. El título
  de la tab sigue al panel activo.

## Paneles divididos

- **Árbol** (`Layout`): una hoja `{ type: 'pane', paneId }` o un split `{ type: 'split', id,
  direction, children, sizes }`. `horizontal` = hijos lado a lado (divisores verticales),
  `vertical` = apilados; `sizes` en % suman 100. Anidable sin límite.
- **Forma canónica** (`normalizeLayout`): un split de un solo hijo se reemplaza por el hijo, y un
  split dentro de otro de la misma dirección se fusiona con su padre (dividir dos veces a la
  derecha da tres hermanos, no splits anidados). Así el doble clic en un divisor iguala lo visible.
- **Dividir** (`splitPane`): el panel nuevo recibe la mitad del espacio del panel dividido y el foco.
- **Cerrar** (`closePane`): el hermano adyacente (el anterior; si no hay, el siguiente) hereda el
  espacio y, si el cerrado tenía el foco, el panel de ese hermano más cercano lo toma. El último
  panel cierra la tab.
- **Foco por posición** (`focusDirection`): el panel más cercano en esa dirección que comparte
  borde; desempates por mayor borde compartido, luego centro más cercano, luego orden visual.
- **Zoom** (`zoomedPaneId`): el panel ocupa toda la tab; los demás quedan ocultos (y sin WebGL).
  Mover el foco a otro panel, dividir o cerrar restaura el layout.
- **Mover paneles entre tabs** (fase futura): `movePane` ya existe y está testeado. Como los panes
  viven en un mapa global y se renderizan planos, mover una hoja de árbol no desmonta su terminal
  ni toca su sesión; falta solo la UI de arrastre.
- **Menú del panel**: Shift+clic derecho (o Shift+F10 / tecla menú). El clic derecho solo sigue
  copiando/pegando, como en Windows Terminal.

## Shell integration

La shell le cuenta a la terminal dónde está y qué ejecuta con secuencias OSC (las mismas marcas
que VS Code y Windows Terminal). ConPTY las deja pasar tal cual (verificado).

| Secuencia | Cuándo | Para qué |
|---|---|---|
| `OSC 7 ; file://<host>/C:/a%20b/%C3%91` | en cada prompt | cwd del panel (UTF-8 + `%XX`; UNC: `file://server/share/...`) |
| `OSC 133 ; A` / `B` | inicio / fin del prompt | la shell está libre |
| `OSC 633 ; E ; <línea>` | antes de ejecutar | último comando (escape de VS Code: `\\`, `\x3b`, `\xHH`) |
| `OSC 133 ; C` / `D ; <código>` | inicio / fin del comando | "comando en ejecución" y su exit code |
| `OSC 633 ; P ; Shell=<shell>` | al cargar | la integración funciona |
| `OSC 633 ; P ; IntegrationError=<msg>` | si no carga | aviso en la status bar |
| `OSC 9 ; 9 ; C:\ruta` | en cada prompt de **cmd** | cwd del panel (ruta Windows cruda, como Windows Terminal) |
| `OSC 9 ; <mensaje>` | cuando un programa quiere avisar | notificación (estilo iTerm2 / Windows Terminal; `9;<número>` es de ConEmu y no cuenta) |
| `OSC 777 ; notify ; <título> ; <texto>` | ídem | notificación (estilo Ghostty / urxvt) |
| `BEL` | ídem | pedido de atención (campana) |

- **Scripts** en `src-tauri/resources/shell-integration/` (recursos de Tauri: en dev se copian a
  `target/debug/shell-integration`, en el bundle van junto al exe). `commands.rs` los resuelve con
  `BaseDirectory::Resource`; `shell.rs::launch` arma la línea de comandos de cada perfil.
- **PowerShell** (`powershell.ps1`, 5.1 y 7; `[char]27` en vez de `` `e ``): se lanza con
  `-NoLogo -NoExit -Command "try { . '<script>' } catch { <OSC 633;P;IntegrationError> }"`. Sin
  `-NoProfile`: el perfil del usuario carga primero, como siempre, y nunca se modifica.
  - Envuelve `prompt` (no lo reemplaza): emite D/OSC 7/A, llama al prompt original (oh-my-posh,
    starship, el del perfil) y agrega B. Le devuelve el `$?` real (con `Write-Error
    -ErrorAction Ignore`, que no ensucia `$Error`) y el `$LASTEXITCODE` del usuario.
  - Envuelve `PSConsoleHostReadLine` para emitir E y C apenas se acepta la línea; PSReadLine
    sigue manejando historial y autocompletado. PSReadLine 2.2+ (pwsh 7) lee `$?` al entrar para
    pintar el prompt de error: el wrapper lo captura y se lo pasa (test en `tests/pty.rs`).
  - Si el usuario (o un módulo) redefine `prompt` o `PSConsoleHostReadLine` más tarde, se
    vuelven a envolver (marcador `__TerminalShellIntegration` en el cuerpo de la función).
  - Exit code: 0 si `$?`; si no, `$LASTEXITCODE` cuando un nativo lo cambió; si no, 1.
  - Sin PSReadLine, E y C se reportan después, desde `Get-History`.
  - Cuerpo en `& { Set-StrictMode -Off ... }`: un perfil con strict mode no lo rompe.
- **Execution policy**: se respeta (es *dot-source* de un archivo, como hace VS Code). Con
  `AllSigned`/`Restricted` el script no carga: la shell funciona igual, el panel queda sin cwd ni
  estado de comandos y la status bar muestra "⚠ Sin integración de shell" (motivo en el tooltip).
  Si el script no responde en 20 s (perfil colgado), el mismo aviso; se borra si responde después.
- **Git Bash** (`bash.sh`): `bash.exe --rcfile <bash.sh> -i` con `CHERE_INVOKING=1` (si no,
  `/etc/profile` hace `cd ~`). El rcfile emula un login (`/etc/profile` y luego
  `~/.bash_profile` / `~/.bash_login` / `~/.profile`), agrega sus hooks a `PROMPT_COMMAND`
  (array) y `PS0` y envuelve `PS1` con A/B. Rutas MSYS → Windows: `/c/x` → `C:/x`, el resto con
  `cygpath -m`. Se detecta por `git.exe` en el PATH o las rutas de instalación habituales.
- **cmd**: no tiene hooks, pero su `PROMPT` admite secuencias: se le antepone
  `$e]9;9;$P$e\` (al `PROMPT` del usuario si tiene uno; si no, a `$P$G`). Solo informa la
  carpeta: integración `cwd` (sin aviso). El explorador no le escribe `cd` (no sabe si está
  ocupado). Verificado a través de ConPTY (`cmd_reports_its_folder_through_the_prompt`).
- **WSL** (una distro por perfil, detectadas desde el registro: `HKCU\...\Lxss`, como Windows
  Terminal; sin lanzar `wsl.exe --list`, que puede tardar un segundo; las `docker-desktop*` no
  cuentan): `wsl.exe -d <distro> --cd <carpeta Windows | ~> -e sh -c <lanzador>`. El lanzador
  (`WSL_LAUNCHER` en `shell.rs`) ejecuta la shell de login del usuario: si es bash, con
  `--rcfile bash.sh` (la ruta llega traducida por `WSLENV=TERMINAL_WSL_RCFILE/p`); si es otra
  (zsh, fish), sin integración y avisando el motivo con `IntegrationError`. `bash.sh` detecta
  WSL (`$WSL_DISTRO_NAME`): `/mnt/c/x` → `C:/x`, y el resto como
  `file://wsl.localhost/<distro>/<ruta>` → `\\wsl.localhost\<distro>\...`. El `cd` del
  explorador usa `wslpath -u`; insertar rutas, `/mnt/<letra>/...`. **No verificado con WSL
  real** (no está instalado acá): el lanzador se prueba con el `sh` de Git, y la rama WSL de
  `bash.sh` con Git Bash y `WSL_DISTRO_NAME` puesto.
- **Frontend** (`lib/shellIntegration.ts`): `registerOscHandler` para 7, 9 (solo `9;9`), 133 y
  633 → eventos puros → `applyShellEvent` en el modelo. Cada `Pane` guarda `cwd`,
  `lastCommand`, `lastExitCode`, `commandRunning`, `integration` (`pending`/`ok`/`unavailable`/
  `error`, y `cwd` para cmd o `none` para un perfil sin integración, ambos sin aviso), el perfil
  y el tipo de shell. Un OSC 7 que llega **mientras corre un comando** se ignora (ssh a otra
  máquina, shells anidadas: no es la carpeta del panel).
- **cwd heredado**: dividir y duplicar usan el perfil y la carpeta del panel; nueva tab, el perfil
  por defecto (o el elegido en "▾") en su carpeta inicial si la tiene, si no en la del panel
  activo (`spawnOf`: `cwd` reportado, si no la carpeta de arranque). El reinicio tras `exit`
  arranca donde estaba. Si la carpeta ya no existe o no se puede listar, el backend usa la
  carpeta del usuario (`resolve_cwd`, que expande `~` y `%VARIABLES%`, y reintenta ahí si el
  spawn falla), sin mostrar error.
- **Status bar** (`StatusBar.tsx`): cwd del panel activo (home como `~`, segmentos del medio
  colapsados en `…` según el ancho; ruta completa en el tooltip), comando en ejecución o ✓/✗ con
  el código, aviso de integración y nombre de la shell. La tab muestra la carpeta como subtítulo
  si no fue renombrada.
- **Cerrar**: la confirmación incluye el comando en ejecución según OSC 133 además de los
  procesos de `session_busy`. Así también pregunta por trabajo sin procesos hijos
  (`Start-Sleep`, un script de PowerShell largo).
- **Selector de perfil**: "▾" junto al "+" lista todos los perfiles visibles (el de por defecto
  muestra `Ctrl+Shift+T`) y abre la configuración. Ver "Configuración, temas y perfiles".
- zsh/fish en WSL (pendiente): scripts propios (precmd/preexec en zsh) elegidos por el lanzador.

## Diseño y barra de título

- **Tokens** (al principio de `styles.css`, el único lugar): `--radius` (=
  `appearance.cornerRadius`, 0–16, por defecto 8) y sus derivados `--radius-xs` (×0,5),
  `--radius-sm` (×0,75: tabs, botones, campos, chips) y `--radius-lg` (×1,25: diálogos, paleta);
  `--gap` (6 px entre tarjetas, 0 con esquinas cuadradas), `--space-1..4`, `--line` (borde de
  1 px), `--shadow-sm/md/lg` (con `--shadow-alpha`, más suave en temas claros), `--hover` y
  `--pressed` (un tinte del color del texto: sirven sobre cualquier superficie),
  `--titlebar-height` y `--tab-height`. Ningún `border-radius` en px suelto (salvo los círculos
  de los indicadores, `50%`). `lib/appearance.ts` publica `--radius`, `--gap` y `--shadow-alpha`
  en vivo y marca `<html data-cards>` cuando el radio es mayor que 0.
- **Tarjetas** (`data-cards`): el fondo de la app es el chrome; explorador, panel de IA y cada
  panel de terminal son tarjetas con borde, radio y `--gap` entre ellas (el espacio entre paneles
  muestra el chrome; la línea del divisor solo aparece al arrastrar). Con radio 0 vuelven a tocarse
  con líneas de 1 px. Las tarjetas del explorador y del panel de IA **no** llevan
  `overflow: hidden`: recortaría el borde de redimensionado, que vive en el espacio entre tarjetas
  (pasó; lo encontró la e2e). Lo que scrollea adentro redondea sus esquinas de abajo.
- **Barra de título propia** (`appearance.titleBar: "custom"`, por defecto): sin la barra de
  Windows (`decorations(false)` + `shadow(true)`, que conserva sombra, bordes de resize y las
  esquinas de Windows 11). La barra de tabs es la barra de título: su espacio vacío
  (`data-tauri-drag-region` en `.tab-bar`, `.tab-strip` y `.tab-bar-space`) arrastra la ventana y
  el doble clic maximiza / restaura (script de Tauri; tabs y botones no arrastran). Un borde de 4 px
  arriba (`.window-resize-top`, sin maximizar) redimensiona por arriba (`startResizeDragging`).
  Botones minimizar / maximizar-restaurar / cerrar (`WindowControls.tsx`, 46 px como Windows, con
  los colores del tema; cerrar en rojo al pasar). Con la ventana inactiva, la barra se atenúa.
- **Snap Layouts** (`src-tauri/src/titlebar.rs`): Windows 11 los muestra si `WM_NCHITTEST`
  responde `HTMAXBUTTON` sobre el botón de maximizar, pero el WebView cubre toda el área cliente.
  Como Windows Terminal: una ventana hija nativa (`BrisaCaptionButtons`, layered + sin bitmap de
  redirección: no dibuja nada y recibe el mouse) sobre los tres botones, en el hilo principal.
  Responde `HTMINBUTTON` / `HTMAXBUTTON` / `HTCLOSE`, avisa a la página hover y presionado (la
  página los pinta) y al soltar manda `SC_MINIMIZE` / `SC_MAXIMIZE` / `SC_RESTORE` / `SC_CLOSE`.
  La página informa dónde están los botones en px físicos (`devicePixelRatio`) en cada cambio de
  layout o tamaño. Una ventana hija layered necesita Windows 8+ en el manifiesto: `build.rs`
  embebe `app.manifest` (el de Tauri + `supportedOS`). Sin la ventana hija, los botones de la
  página funcionan solos (sin Snap Layouts).
- **Barra nativa** (`appearance.titleBar: "native"`), en vivo: `set_title_bar` vuelve a poner
  las decoraciones de Windows, quita la sombra propia y la ventana hija; la barra de tabs queda
  debajo, sin botones. La ventana se crea con el modo que diga settings.json (`settings::window_look`).

## Colores

- Todo sale del tema: `background` (terminales), `sidebar` (explorador y panel de IA: apenas más
  oscuro), `chrome` (barra de título, barra de estado y lo que se ve entre tarjetas: más oscuro
  todavía), `panel` (menús, diálogos, campos), `border`. Nunca negro puro contra el fondo (el
  "Oscuro" tenía `#010409` contra `#0d1117`).
- Incluidos: la jerarquía de cada paleta oficial donde existe (Catppuccin crust / mantle / base,
  Dracula, Tokyo Night, One Dark); Oscuro y Claro, ajustados a mano. Importados o propios sin
  `ui`: `deriveUi` (oscuros: hacia el negro un 15 % el sidebar y un 30 % el chrome; claros: hacia
  el texto un 3 % y un 7 %). Test: en todos los temas chrome < sidebar < terminal en luminancia,
  sutil y sin negro.

## Explorador de archivos

Barra lateral a la izquierda (`Ctrl+B`), entre la barra de tabs y la de estado. Sigue el cwd del
panel activo (el de la shell integration; si no hay, la carpeta de arranque; si no, home) al
cambiar de cwd, de panel o de tab, salvo que esté **fijada** (botón de pin).

- **Backend** (`src-tauri/src/explorer/`, sin Tauri como `pty/`; comandos finos en
  `explorer_commands.rs`, todo en `spawn_blocking`):
  - `list.rs`: un nivel por vez (carga perezosa: se lee al expandir). Cada entrada dice por qué
    estaría oculta: `default` (`DEFAULT_HIDDEN`: node_modules, .git, bin, obj, target, .vs,
    .venv…; solo carpetas), `ignored` (`.gitignore`, `.git/info/exclude`, excludes global; con el
    crate `ignore`, solo dentro de un repo) o `system` (atributo oculto/sistema). El frontend
    filtra con el toggle "ver ocultos" sin volver a leer; los hijos de una carpeta oculta heredan.
    Orden: carpetas primero, nombre natural (`a2` antes que `a10`).
  - `watch.rs`: un watcher de `notify` por página, **no recursivo**, solo sobre las carpetas
    visibles (raíz + expandidas). `watch_set` recibe el conjunto completo, libera el resto y
    devuelve lo que vigila; el explorador oculto vigila cero. Debounce de 150 ms (máx. 600 ms con
    cambios continuos); se reporta qué carpetas cambiaron y el frontend re-lista solo esas.
    Cambios dentro de `.git` se ignoran. Máximo 256 carpetas. Al empezar a vigilar una carpeta
    se la vuelve a listar: un cambio entre el primer listado y el watch se perdía (lo encontró la
    e2e).
  - `git.rs`: `git rev-parse --show-toplevel` + `git --no-optional-locks status --porcelain=v2
    --branch -z --untracked-files=normal`, con `GIT_OPTIONAL_LOCKS=0`, sin ventana y timeout de
    15 s (repos enormes: se abandona, no se apilan procesos). Rama, ahead/behind y cambios.
  - `ops.rs`: crear archivo/carpeta (nunca sobrescribe), renombrar (valida nombres de Windows:
    caracteres, `CON`/`NUL`…, punto o espacio final), papelera con `SHFileOperationW`
    (`FOF_ALLOWUNDO` + `FOF_WANTNUKEWARNING`: si no hay papelera, Windows pregunta en vez de
    borrar en silencio), abrir en VS Code (`code.cmd` del PATH o instalaciones habituales) y en el
    Explorador (`explorer /select,"…"` con `raw_arg`).
  - Los watchers pertenecen a la página (label) como las sesiones: recargar, cerrar la ventana o
    salir los libera.
- **Frontend**: lógica pura en `lib/explorerModel.ts` (rutas, comillas por shell, árbol aplanado,
  decoraciones de git; con tests). Estado en `store/explorer.ts` (visible, ancho, ver ocultos,
  fijado, expandidas, listados de lo visible) y `store/git.ts` (estado por repo). Carga y watcher
  en `lib/explorerData.ts`; acciones en `lib/explorerActions.ts`.
- **Árbol virtualizado** (`FileTree.tsx`): filas de 22 px absolutas, solo las visibles más un
  margen. 5000 archivos = ~40 filas en el DOM y ninguna tarea larga (medido en e2e).
- **Breadcrumbs** (`Sidebar.tsx` + `fitCrumbs` en `explorerModel.ts`, pura y con tests): si la
  ruta no entra, el primero y el último siempre se ven y los del medio se colapsan en "…" (se
  conservan los más cercanos a la carpeta actual); "…" abre un menú con los ocultos, en orden. Los
  anchos salen de una copia invisible de cada crumb; se recalcula al cambiar el ancho del
  explorador.
- **Clic en una carpeta** → `cd` en el panel activo **solo si** la integración dice que la shell
  está libre (sin comando en ejecución, OSC 133) y el prompt está vacío (lo escrito desde la
  marca 133;B, `ShellIntegrationHandle.promptInput()`). Si no, no se escribe nada en esa
  terminal: aviso discreto con "Abrir tab aquí". Sin integración tampoco se escribe.
  PowerShell: `Set-Location -LiteralPath '…'`; Git Bash: `cd -- '/c/…'`. Un breadcrumb hace lo
  mismo (fijado: navega la carpeta fijada).
- **Clic en un archivo** → su ruta en el prompt del panel activo, sin ejecutar, vía `term.paste`
  (bracketed paste si el programa lo pidió: los agentes lo reciben como pegado). PowerShell:
  comillas simples, duplicando `'` y sus variantes tipográficas (PowerShell también las toma como
  comillas). Git Bash: ruta MSYS entre comillas simples (`'\''` para una comilla). Siempre con
  comillas y un espacio al final.
- **Arrastrar** una fila a una terminal pega la ruta en **ese** panel (lo resalta mientras tanto).
  Con `dragDropEnabled` (default de Tauri) el drag & drop HTML5 no funciona en Windows: el
  arrastre interno usa pointer events (`lib/dropTarget.ts`, `paneAt` con `elementFromPoint`).
  Archivos desde el Explorador de Windows: evento nativo `onDragDropEvent` de Tauri (posición en
  píxeles físicos → CSS) → mismo `insertPaths`. La e2e emite ese mismo evento con
  `plugin:event|emit_to`.
- **Git**: rama (↑/↓ y • si hay cambios) en la barra de estado para el cwd del panel activo;
  colores en el árbol (modificado amarillo, nuevo/sin seguir verde, renombrado azul,
  conflicto/borrado rojo; las carpetas toman el cambio más fuerte de adentro; ignorados y ocultos
  atenuados). Se refresca al cambiar la raíz, cuando el watcher ve cambios (400 ms) y al
  terminar cualquier comando en un panel (OSC 133: `git commit`/`checkout` desde la terminal).
  Un solo proceso git por carpeta a la vez; un pedido durante una corrida la repite una vez.
- **Menú contextual**: abrir en VS Code, en el Explorador de Windows, tab nueva aquí, dividir
  aquí, copiar ruta, copiar ruta relativa (a la raíz del explorador), nuevo archivo, nueva
  carpeta (input en línea), renombrar (`F2` con el árbol enfocado) y eliminar (`Supr`; a la
  papelera, con confirmación con foco en Cancelar).
- **Preferencias**: visible, ancho y "ver ocultos" en `settings.json` (`explorer.*`, ver abajo).
  Ctrl+B y "ver ocultos" se guardan al instante; el ancho, al soltar el borde.
- **Clic en carpeta**: `explorer.folderClick` = `cd` (lo de arriba) o `navigate` (el explorador
  entra en la carpeta y queda fijado; la shell no se toca).
- **RAM** (números en "Estado"): el árbol cuesta poco porque solo se guarda lo visible; al
  colapsar u ocultar se descartan listados y watchers.

## Configuración, temas y perfiles

- **Carpeta**: `%APPDATA%\dev.brisa.desktop\` (la variable `BRISA_CONFIG_DIR` la cambia: la e2e
  usa una descartable). Adentro: `settings.json` (+ `settings.schema.json`), `layouts.json` (+
  `layouts.schema.json`) y `session.json`.
- **Migración del nombre viejo** (`settings::migrate_legacy`, al arrancar, solo sin
  `BRISA_CONFIG_DIR`): si existe `%APPDATA%\dev.terminal.desktop` y la carpeta nueva no tiene
  settings.json, se **mueve** entera (un `rename`: settings, temas importados, layouts, sesión); si
  no se puede (la vieja en uso, o la nueva ya existe) se copia archivo por archivo sin pisar nada y
  la vieja queda como estaba. Tests `the_old_config_folder_moves_to_the_new_name` y
  `an_existing_new_folder_gets_copies_without_overwriting`. Lo que **no** se migra: los datos de
  WebView2 (`%LOCALAPPDATA%\dev.terminal.desktop`, solo caché y el tema cacheado en
  `localStorage`): el primer arranque pinta el tema por defecto un instante.
- **settings.json**: JSONC (comentarios y comas finales). Solo guarda lo que difiere del valor
  por defecto: lo que no está, vale el default; una sección que queda vacía al volver a los
  defaults se borra (salvo que tenga un comentario del usuario). Arranca con
  `"$schema": "./settings.schema.json"` (generado del esquema en cada arranque, solo si cambió):
  VS Code autocompleta y documenta cada clave.
- **Esquema** (`config/settingsSchema.ts` con la mini librería `config/schema.ts`): una sola
  definición da los tipos de TS (inferidos), los defaults, la validación y el JSON Schema.
  Secciones: `appearance` (fuente, tamaño, line-height, ligaduras, cursor, padding, opacidad,
  efecto, `cornerRadius`, `titleBar`; ver "Diseño y barra de título"), `theme` + `themes`, `terminal` (scrollback, copiar al seleccionar, clic derecho),
  `explorer` (arranque, ancho, ocultos, clic en carpeta), `profiles` (`default`, `list`),
  `session` (`restore`), `blocks` (`enabled`), `agents` (`enabled`, `idleSeconds`, `commands`),
  `notifications` (`enabled`, `bell`, `agents`), `ai` (`enabled`, `provider`, `model`,
  `claudePath`, `redact`; ver "IA") y `keybindings` (ver "Atajos configurables").
- **Errores**: JSON roto o un valor inválido (tipo, rango, opción) → el archivo entero se
  rechaza y **sigue la última configuración válida**; la barra de estado muestra
  "⚠ settings.json" (tooltip con línea/ruta y motivo; clic → la configuración, que lista los
  problemas y bloquea los cambios hasta corregirlo, para no escribir sobre un archivo a medio
  editar). Claves desconocidas: aviso, el resto se aplica.
- **En vivo** (`lib/settingsSync.ts`): el archivo se vigila con el watcher del explorador (la
  carpeta de config, no recursivo) y cada cambio se valida y aplica sin reiniciar. Los cambios
  hechos desde la UI editan **solo ese valor** del texto con `jsonc-parser` (`modify`): los
  comentarios, el orden y el formato del usuario se conservan; el valor por defecto borra la
  clave. Escritura atómica (temporal + rename) en Rust; mientras una escritura propia está en
  vuelo, los avisos del watcher se posponen para no aplicar una versión vieja.
- **Migración**: `localStorage['terminal.explorer']` (Fase 5) pasa a `explorer.*` la primera vez
  (solo lo que el archivo no define) y se borra; si el archivo tiene errores, se conserva.
- **Pantalla** (`Ctrl+,`, `SettingsPage.tsx` + `components/settings/`): Apariencia, Temas,
  Perfiles, Terminal, Explorador, Bloques y agentes, IA, Atajos y Sesión y layouts; números y textos se guardan con
  Enter o al salir del campo; "Abrir settings.json en VS Code" (si no está, la app asociada a
  .json). Mientras está abierta, los atajos de la app no corren (salvo el de la configuración) y
  nadie le roba el foco; Esc la cierra.
- **Temas** (`config/themes.ts`): Oscuro (el de siempre), Claro, Catppuccin Mocha y Latte,
  Dracula, Tokyo Night y One Dark. Un tema son los 16 colores ANSI + fondo/texto/cursor/selección
  y, opcional, los colores de la UI (`ui`: background, chrome, sidebar, panel, border, text,
  muted, accent, danger, warning, success); lo que falta se deriva de la paleta (ver "Colores"). `lib/appearance.ts` los
  pone como variables CSS en `<html>` (todo `styles.css` usa variables, también git, estados y
  los colores de tabs/grupos, que tienen una paleta para temas oscuros y otra para claros) y
  cachea las variables en `localStorage` para pintar el tema correcto antes de leer el archivo.
  **Importar**: pegar el JSON (o soltar un `.json` desde el Explorador de Windows) en Temas;
  acepta el formato propio, un esquema de Windows Terminal (`purple` = magenta, `cursorColor`),
  una lista o un fragmento con `"schemes"`. Se guarda en `themes` en formato propio y se elige.
  Un tema propio con el nombre de uno incluido lo reemplaza.
- **Terminales**: cada panel aplica en vivo fuente, tamaño (+ el zoom de la sesión, que no se
  guarda), cursor, scrollback y el tema **de su perfil** (o el global); el panel se pinta con el
  fondo de su tema y el padding queda adentro (`.terminal-pane` > `.terminal-host`, que es lo que
  mide `fit()`).
- **Ligaduras** (`lib/ligatures.ts`): un *character joiner* de xterm con las secuencias comunes
  (la lista de respaldo de `@xterm/addon-ligatures`); la fuente hace el resto con `calt`. No se
  usa el addon: lee el archivo de la fuente con Node o pide permiso de acceso a fuentes, y pesa
  ~200 KB. Requiere una fuente con ligaduras (Cascadia Code, Fira Code, JetBrains Mono).
- **Opacidad y Mica/Acrylic**: la transparencia de la ventana se fija al crearla, así que la
  ventana principal se crea en Rust (`lib.rs`, no en `tauri.conf.json`) leyendo `appearance`
  del archivo: **opaca salvo que se pida** efecto u opacidad < 100 (sin costo para el resto).
  Creada transparente, cambiar de efecto, de opacidad o de tema claro/oscuro se aplica en vivo
  (`set_window_look`); creada opaca, la pantalla avisa que se aplica al reiniciar. Con
  transparencia xterm usa `allowTransparency` (el atlas de WebGL se reconstruye) y el fondo lo
  pinta el panel con alfa; con efecto, la barra de tabs y la de estado dejan pasar el fondo.
- **Copiar al seleccionar**: al soltar el mouse con selección (arrastre, doble o triple clic);
  las selecciones de la búsqueda no se copian.
- **Clic derecho**: `copyPaste` (copiar o pegar, como Windows Terminal) o `menu` (Copiar, Pegar,
  Seleccionar todo, Buscar, Limpiar + las acciones del panel). Shift+clic derecho siempre abre el
  menú.

### Perfiles

- **Detectados** (`pty/shell.rs::available_shells`, en este orden): PowerShell 7 (`pwsh`, si
  está), Windows PowerShell (`powershell`), Símbolo del sistema (`cmd`), Git Bash (`gitbash`) y
  una por distro WSL (`wsl-<distro>`). El primero es el de por defecto.
- **Del usuario** (`config/profiles.ts`): `profiles.list` en settings.json. Una entrada con el id
  de uno detectado lo personaliza; otra, con `command`, es un perfil propio (id `custom-<nombre>`
  si no tiene). Campos: `name`, `icon` (emoji o texto corto, o `powershell`/`pwsh`/`cmd`/`git`/
  `linux`/`terminal`, monogramas incluidos), `command`, `args`, `cwd` (carpeta inicial de tabs
  nuevas), `env`, `theme` y `hidden`. `profiles.default` elige el de `Ctrl+Shift+T`.
- **Lanzamiento**: el frontend manda un `ShellSpec` (`kind`, `program`, `args`, `env`, `distro`);
  Rust decide qué significa (`shell.rs::resolve` + `launch`): busca el programa (nombre en el
  PATH, `%VARIABLES%`), deduce el tipo por el nombre si es un comando propio y arma integración y
  entorno. Sin `args`, los de siempre con integración. Con `args` propios: PowerShell conserva la
  integración salvo que tomen el control (`-Command`, `-File`, `-EncodedCommand`, `-NoExit`, un
  script; nombres abreviados incluidos, test `powershell_user_arguments_keep_...`); Git Bash y
  WSL no la inyectan; cmd siempre informa su carpeta. Las variables del perfil van al final (ganan).
- Cada panel guarda el perfil pedido y, al arrancar, el que realmente arrancó (un perfil borrado
  reinicia con el de por defecto). Dividir y duplicar usan el mismo perfil.
- El ícono del perfil se ve en la tab y en el menú "▾"; su nombre, en la barra de estado.

## Atajos configurables

- **Registro** (`config/keybindings.ts`, puro, con tests): cada acción de la app con id, nombre en
  español, categoría, **alcance** y teclas por defecto. `global` (en toda la app; en un campo de
  texto solo si tiene Ctrl/Alt: F2 o Supr son del campo), `terminal` (solo con el foco en una
  terminal: copiar, pegar, buscar, Shift+Enter) y `explorer` (solo en el árbol: renombrar,
  eliminar). `repeat`: mantener apretado repite (moverse entre tabs y paneles); el resto actúa
  una vez por pulsación y la tecla igual no llega al programa. `passthrough`: actúa solo a veces
  y si no la tecla sigue al programa (Ctrl+C copia **solo** si hay selección).
- **settings.json** `keybindings`: `{ "acción": "tecla" | ["tecla", ...] }`; `[]` la deja sin
  atajo; lo que no está usa el default. Formato de VS Code/Windows Terminal (`ctrl+shift+t`,
  `alt+left`, `shift+f10`, `ctrl++`, `supr`), normalizado a `ctrl+alt+shift+meta+tecla`. Una
  tecla mal escrita o que bloquearía la escritura (sin Ctrl/Alt: una letra, Espacio, Enter) es un
  error (el archivo se rechaza como cualquier otro error); una acción desconocida, un aviso.
  El JSON Schema documenta cada acción con su default.
- **Despacho** (`lib/appShortcuts.ts`): **un solo listener** en captura sobre `window` para todo
  (también lo que antes hacía el key handler de xterm). Contexto por el `target` del evento
  (terminal = la textarea de xterm; explorador; campo de texto; resto); entre las acciones de esa
  tecla gana la de alcance específico, después la que el usuario asignó, después el orden del
  registro. Ejecuta (`lib/appActions.ts`) y frena el evento; `native` (Ctrl+V, Ctrl+Shift+V,
  Shift+Insert) solo frena la propagación, así xterm no manda `^V` y Chromium dispara el `paste`
  nativo (bracketed paste incluido); un atajo de pegar propio lee el portapapeles y usa
  `term.paste`. Con un diálogo abierto, grabando una tecla o con la paleta/configuración
  abiertas solo corre el atajo que las cierra.
- **Teclas de un evento** (`eventKeys`): la tecla tipeada primero; dígitos por `code` (Ctrl+Shift+1
  escribe "!"); letras por `code` solo si el layout no escribe una letra latina ahí (Dvorak:
  Ctrl+X sigue siendo Ctrl+X); un símbolo con Shift también vale por la tecla donde está
  (Alt+Shift+- escribe "_") y, si el atajo no dice Shift, por sí mismo (`ctrl++` es Ctrl+Shift+=
  en un teclado US). Ctrl+Alt con un carácter es AltGr: solo ese carácter (AltGr+2 = "@" nunca
  es Ctrl+Alt+2).
- **Conflictos** (`keymapConflicts`): una tecla en dos acciones que verían la misma pulsación
  (mismo alcance, o global + terminal; global + explorador no: el árbol tiene su F2); teclas que
  bloquean la escritura; y teclas que usan los programas (`RESERVED_KEYS`: Ctrl+C/D/Z/R/W/A/E/K/
  U/L/T/P/N/F/B/O/X/S/Q…, Alt+B/F/D/., flechas, Esc, Shift+Tab…, cada una con para qué la usan;
  Ctrl+V no, es la convención de Windows). El único aviso con los defaults es Ctrl+B (explorador,
  como en VS Code; readline y tmux la usan), deliberado.
- **Pantalla Atajos** (`components/settings/KeybindingsSection.tsx`): por categoría, buscar por
  nombre o tecla, quitar (×), agregar (+ y se graba la pulsación; Esc cancela), volver al
  default (↺) y "Restaurar los valores por defecto" (borra `keybindings`). Al grabar, una tecla
  de otra acción ofrece **Reasignar** (se la saca a la otra); una que usan los programas avisa
  para qué y pide "Asignar igual"; una que escribe se rechaza. Los conflictos escritos a mano
  se marcan en la lista. Los menús y tooltips muestran los atajos en uso (`shortcutLabel`).
- Teclas internas de un widget (Enter/Esc/flechas en menús, búsqueda, renombrar, paleta) no se
  configuran.

## Paleta de comandos

- `Ctrl+Shift+P` (`CommandPalette.tsx`, ítems en `lib/paletteItems.ts`): todas las acciones con
  su atajo, más lo del momento: ir a una tab o a un panel (de tabs divididas) por nombre o
  carpeta, nueva tab con cada perfil, aplicar cada tema (el en uso marcado) y abrir cada layout.
- **Búsqueda difusa** (`lib/fuzzy.ts`, pura, con tests): los caracteres en orden, sin importar
  mayúsculas ni tildes; cada palabra por su cuenta y en cualquier orden ("dracula tema");
  puntúan los inicios de palabra y las rachas ("dvd drch" → Dividir el panel a la derecha).
- **Recientes**: lo ejecutado desde la paleta va primero con la búsqueda vacía y suma puntos con
  búsqueda; se guarda en `session.json` (`recent`, 20). Las tabs y paneles no (cambian de id).
- Flechas/RePág/AvPág, Enter, clic; Esc o clic afuera cierra y devuelve el foco a la terminal.

## Sesión

- `lib/sessionSync.ts`: al arrancar se leen settings, shells, layouts y `session.json` **antes**
  de montar ninguna terminal (el store arranca vacío; `App` espera `useSession.ready`), y se
  restaura la ventana o se abre una tab. Se restauran tabs (nombre propio, color, grupo), grupos
  (nombre, color, colapsado), el layout de paneles con sus tamaños, el panel activo y el
  maximizado, la tab activa, y el **perfil y la carpeta** de cada panel (la última que informó
  la shell, si no la de arranque). El contenido de las terminales no. Una carpeta que ya no
  existe → la del usuario (lo resuelve `resolve_cwd` en el backend).
- **Guardado**: cada cambio del store programa un guardado a los 250 ms (máximo 1 s aunque
  sigan llegando cambios, p. ej. un título que cambia todo el tiempo); se escribe solo si el
  texto cambió, de a una escritura por vez, **atómica** (temporal + rename en Rust: un crash deja
  la versión anterior). Cerrar la última tab guarda una sesión vacía antes de cerrar la ventana
  (la próxima vez, una tab nueva). Cerrar con la X no toca el archivo: queda lo último guardado.
- `session.restore: false`: no se restaura ni se guardan tabs (`window: null`; los recientes de
  la paleta sí). Un `session.json` ilegible o de otra versión = sin sesión.
- Formato: el mismo de los layouts (`store/layoutModel.ts`: `snapshotWindow` / `instantiate`,
  puros y con tests), más `version` y `recent`. Recargar la página también restaura (la e2e lo
  tiene en cuenta: tras `reloadApp()` vuelve la sesión, no una tab nueva).

## Layouts guardados

- **Guardar** la tab activa o la ventana entera (paleta, menú "▾" o Configuración → Sesión y
  layouts): diálogo con el nombre (por defecto el de la tab; uno existente se reemplaza) y un
  **comando inicial opcional por panel**, sugerido con lo que corre ahí ahora (`npm run dev`,
  `claude`). Se guarda en `layouts.json` editando solo esa entrada (los comentarios quedan).
- **layouts.json** (JSONC, con `layouts.schema.json` al lado y un comentario que explica el
  formato al crearlo): `{ "layouts": [{ "name", "tabs": [...], "groups": [...] }] }`. Una tab:
  `title`, `color`, `group` (nombre de un grupo) y un panel (`profile`, `cwd`, `command`) o un
  `layout` con divisiones `{ "split": "horizontal" | "vertical", "sizes": [..], "panes": [..] }`
  (`focus`/`zoom` opcionales). Un grupo que reaparece separado es otro grupo. Se vigila como
  settings.json (cambios a mano en vivo). Cada layout se valida por separado: uno roto se deja
  afuera con su aviso; JSON roto → siguen los de antes, "⚠ layouts.json" en la barra de estado y
  la app no escribe encima.
- **Abrir** (paleta "Abrir layout:", menú "▾", Configuración): las tabs se agregan al final; si la
  ventana es solo una tab sin usar (sin comandos, nada escrito, sin nombre ni grupo), el layout
  la reemplaza.
- **Comandos iniciales** (`lib/initialCommands.ts`): se escriben (+ Enter) **solo** cuando la
  integración dice que la shell está lista: llegó el `133;B` del prompt (hook `onInputStart` de
  `registerShellIntegration`), integración `ok`, ningún comando corriendo y el prompt vacío. Nunca
  antes. En una shell sin `133` (cmd, un perfil propio, integración que no cargó), con texto ya
  escrito, si la shell termina o si no hay prompt en 30 s, no se escribe y un aviso (toast) dice
  por qué.

## Bloques de comandos

- **Qué es un bloque** (`lib/blocks.ts`, `BlockTracker` por terminal): un comando y su salida,
  según las marcas de la integración: `133;A` (empieza el prompt), `B` (empieza lo tipeado),
  `633;E` (el comando exacto), `C` (empieza la salida) y `D;<código>` (termina). Cada posición es
  un *marker* de xterm, que sigue a su línea cuando el scrollback se mueve; un bloque cuyo
  prompt salió del scrollback se descarta (máximo 1000 por terminal). El tracker registra sus
  handlers OSC **después** de la integración y devuelve `false`: ve las marcas primero y no las
  consume. Un prompt sin comando (Enter vacío, Ctrl+C) no es bloque; un comando cuyo `D` nunca
  llegó termina en el próximo `A`.
- **Pantalla completa y agentes**: si el comando usa el buffer alternativo (vim, htop) o el
  monitor de agentes detecta un agente en el panel (su TUI dibuja en el buffer normal), el
  bloque se descarta y, mientras corre, no se muestra ninguna marca.
- **Margen**: un `div.block-gutter` sobre el panel (en el padding, a la izquierda del texto);
  posiciones calculadas desde `.xterm-screen` y redibujado en un `requestAnimationFrame` ante
  render, scroll, cambio de buffer, hover o selección, pero el DOM solo se toca si cambió lo que
  se ve (firma de marcas, posiciones, hover, selección y botón): xterm renderiza con cada tecla y
  con el parpadeo del cursor, y una marca reemplazada entre mousedown y mouseup perdía el clic
  (también lo veía la e2e: `boundingBox` de un elemento recién reemplazado). Los que fallaron (código ≠ 0) tienen
  siempre una marca roja; al pasar el mouse sobre cualquiera aparece su marca, y un clic abre el
  menú (`MenuState` `block`): copiar comando, salida o ambos (el portapapeles de Windows guarda
  CRLF) y volver a ejecutar (con la shell libre y el prompt vacío se ejecuta; si hay algo
  escrito, se inserta sin ejecutar; con un comando corriendo, no se escribe nada).
- **Ctrl+↑ / Ctrl+↓** (`blocks.previous` / `blocks.next`, alcance terminal, `passthrough`):
  seleccionan el bloque anterior / siguiente (banda resaltada) y lo traen a la vista; pasado el
  último, vuelve al prompt. Sin bloques, con un programa de pantalla completa o un agente, la
  tecla sigue al programa. Tipear quita la selección.
- **IA** (con `ai.enabled`): al pasar el mouse por un bloque fallido aparece "Explicar /
  arreglar" a la derecha de su primera fila (sobre el botón el bloque sigue con hover: antes
  estaba encima de la fila y desaparecía al ir a buscarlo); el menú del bloque suma "Explicar /
  arreglar (IA)" (si falló) y "Agregar al chat de IA". Ver "IA". **API de bloques**
  (`lib/blockActions.ts`): `paneBlocks(paneId)` → `BlockInfo[]` (id, comando, código, cwd,
  inicio y fin) y `blockText(paneId, blockId)` → lo mismo más `output` (filas envueltas unidas,
  sin la línea del comando); `selectedBlock(paneId)` da el seleccionado.
- `blocks.enabled: false` apaga marcas, menú y navegación.

## Agentes de IA y notificaciones

- **Detección** (`lib/agentMonitor.ts` + `session_agents`): cada 2 s, y 0,7 s después de que
  empieza un comando, se pregunta al backend qué agente corre en los paneles que ejecutan algo
  (o que no pueden decirlo: cmd, perfiles sin integración) o que ya tenían uno. El backend usa
  la misma detección que Shift+Enter (`pty/agents.rs`, una foto de la tabla de procesos para
  todas las sesiones). Con todos los paneles en un prompt libre no se consulta nada.
- **Estados** (`Pane.agent`: `{ name, state }`): *trabajando* (produce salida), *esperando tu
  respuesta* (sonó la campana, mandó OSC 9 / OSC 777, o lleva `agents.idleSeconds` sin salida,
  6 s por defecto) y *terminado* (el proceso salió; se va al volver a tipear en el panel). La
  salida hasta 300 ms después de una tecla es eco, no trabajo; y durante 1,5 s después de un
  aviso explícito, un redibujo no lo devuelve a *trabajando*.
- **Indicadores**: en la tab (`tabIndicator`: esperando > proceso con error > trabajando >
  terminado > actividad; punto animado / ámbar / anillo verde, con el agente en el tooltip) y
  en el panel (`AgentBadge`, arriba a la derecha: "Claude Code · espera tu respuesta").
- **Notificaciones nativas** (`notifications.rs`): BEL (`term.onBell`), OSC 9 y OSC 777 de
  cualquier programa, y los cambios de un agente a *esperando* o *terminado*, se vuelven una
  notificación de Windows **solo si el panel no está a la vista** (otra tab, otro panel
  maximizado, la ventana minimizada o sin foco). Las campanas de un panel, como mucho una cada
  5 s (una ráfaga es una). Toast de WinRT con el AppUserModelID de la app registrado en
  `HKCU\Software\Classes\AppUserModelId\dev.brisa.desktop` (nombre e ícono, el PNG se copia a
  `%LOCALAPPDATA%\dev.brisa.desktop`), como hace el Windows App SDK con las apps sin paquete.
  Un toast por panel a la vez (`Tag`). El clic llega en el proceso (`Activated`, los toasts se
  guardan vivos): Rust trae la ventana al frente y manda el panel por el canal de
  `notifications_listen`; el frontend lo enfoca. Verificado una vez con un toast real (quedó
  en el historial del Centro de actividades y se borró); el clic real queda en el smoke manual.
- **e2e**: con `BRISA_NOTIFY_LOG=<archivo>` las notificaciones se escriben ahí (una línea JSON:
  título, texto, tag) en vez de mostrarse; `debug_notification_click` hace lo mismo que el clic.
- **Settings**: `agents.enabled` (detección, indicadores y preset), `agents.idleSeconds`,
  `notifications.enabled`, `notifications.bell`, `notifications.agents`.

### Configurar Claude Code para que avise a Brisa

- Lo recomendado (y documentado por Anthropic): en `~/.claude/settings.json`
  `"preferredNotifChannel": "terminal_bell"`. Según la documentación, con ese valor Claude Code
  manda la campana (BEL) "whatever the terminal or profile". En Brisa, la campana de un panel
  con un agente lo pone en *espera tu respuesta* y, si no está a la vista, avisa con una
  notificación de Windows.
- Valores documentados: `auto` (por defecto: notificación de escritorio solo en Ghostty, Kitty
  e iTerm2; en el resto, nada), `terminal_bell`, `iterm2`, `kitty`, `ghostty`. Por convención
  `iterm2` usa OSC 9 y `ghostty` OSC 777, que Brisa también entiende, pero la documentación no
  dice qué secuencia manda cada uno: **no verificado**.
- Claude Code avisa cuando termina una tarea o se detiene en un permiso "y parece que no estás
  mirando". No está verificado cómo lo decide en Windows (ConPTY consume los reportes de foco,
  ver Gotchas); por eso Brisa también infiere *espera tu respuesta* por silencio.
- El hook `Notification` (matchers `permission_prompt`, `idle_prompt`, …) corre un comando cuando
  Claude Code avisa; sirve para un sonido propio y no hace falta para Brisa.
- Codex: según su configuración de ejemplo, `[tui] notifications = true` y
  `notification_method = "osc9"` en `~/.codex/config.toml` (no verificado).
- Nada de esto se probó con Claude Code real (regla: las pruebas usan el agente falso). Fuentes:
  https://code.claude.com/docs/en/terminal-config, https://code.claude.com/docs/en/settings,
  https://code.claude.com/docs/en/hooks y https://developers.openai.com/codex/config-sample.

## Preset multi-agente y worktrees

- Paleta → "Abrir multi-agente aquí…" (`agents.multiAgent`, `MultiAgentDialog.tsx`): 2, 3 o 4
  paneles en la carpeta del panel activo, cada uno con Claude Code, Codex, Gemini o solo la
  shell. Una tab nueva ("Agentes: …"): 2 lado a lado, 3 = uno a la izquierda y dos apilados, 4 =
  grilla 2×2. Cada agente se escribe con `agents.commands.<agente>` como comando inicial: igual
  que en los layouts, recién cuando la shell está lista según OSC 133.
- **Worktrees** (opcional, solo dentro de un repositorio con commits): uno por panel, junto al
  repo en `<padre>\<repo>.worktrees\<agente>-<n>-<id>`, en una rama nueva `brisa/<agente>-<n>-<id>`
  desde HEAD. Brisa anota los que crea en `worktrees.json` (carpeta de config; lo escribe solo
  el backend) y **solo borra esos** (`WorktreeError::NotOurs` para cualquier otro).
- **Limpieza al cerrar** (`lib/multiAgent.ts`, desde `closePaneNow` / `closeTabsNow`): un
  worktree sin cambios se borra con `git worktree remove` (reintentos: los procesos del panel
  pueden tardar en soltar la carpeta) y su rama con `git branch -d`, que la conserva si el agente
  hizo commits. Uno con cambios sin commitear pregunta ("Conservar", con el foco, o "Borrar
  igual"). Si otro panel sigue trabajando en esa carpeta, se le pasa. Cerrar la app con la X no
  borra nada: la sesión recuerda qué paneles tienen worktree (`PaneSpec.worktree`, solo en
  session.json, nunca en layouts). Los conservados se listan (y se borran) en Configuración →
  Bloques y agentes.

## IA

Tres funciones, todas con `ai.enabled` (un solo interruptor: apagado, Brisa no hace ninguna
llamada de red ni lanza `claude`; además el backend se niega por su cuenta, ver `ai_configure`):
"Explicar / arreglar" en los bloques fallidos, lenguaje natural a comando (`Ctrl+I`) y un chat
corto sobre la terminal (`Ctrl+Shift+I`). No reemplaza a Claude Code: sin herramientas ni
acceso a archivos, solo el contexto que Brisa arma (y muestra).

- **Proveedores** (`ai.provider`, backend en `src-tauri/src/ai/`, sin Tauri, tests en
  `tests/ai.rs`):
  - `claude-cli` (por defecto, `ai/claude_cli.rs`): `claude -p` con la sesión del usuario
    (suscripción, sin API key). Flags verificados contra la documentación
    (code.claude.com/docs/en/cli-reference, /headless, /memory) y contra `claude` 2.1.329:
    `-p --output-format stream-json --verbose --include-partial-messages` (deltas de texto),
    `--tools ""` (ninguna herramienta), `--permission-mode dontAsk`, `--safe-mode` (sin
    CLAUDE.md de usuario ni de proyecto, hooks, MCP, skills ni plugins; la autenticación sigue
    igual: `--bare` **no sirve**, ignora el login OAuth), `--setting-sources user`,
    `--strict-mcp-config`, `--disable-slash-commands`, `--no-session-persistence`,
    `--max-turns 1`, `--model <ai.model>`, `--effort low` en lenguaje natural a comando y
    `--system-prompt-file`. Corre en una carpeta vacía propia (`%TEMP%\brisa-ai`), el prompt va
    por stdin, sin ventana, dentro de un Job Object (cancelar o cerrar la app mata el árbol,
    también `claude.cmd` → node de una instalación npm) y sin las variables de sesión anidada
    (ver abajo) + `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`. El modelo se valida (letras, dígitos,
    `.-_[]`, nunca algo que empiece con `-`). Sin sesión, el CLI responde un `assistant` con
    `"error": "authentication_failed"` y un `result` con `is_error: true` (capturado con un
    `CLAUDE_CONFIG_DIR` vacío: sin credenciales no hay llamada, no consume nada).
    `claude` se busca en `ai.claudePath` (si está y no existe, error: nunca se cae a otro), en
    el PATH (`claude.exe`, `claude.cmd`), `~\.local\bin` y `%APPDATA%\npm`. Una opción
    desconocida (CLI viejo) → "actualizalo con `claude update`".
  - `anthropic-api` (`ai/anthropic.rs` + `ai/http.rs`): Messages API con streaming SSE por
    WinHTTP síncrono en el hilo de la consulta (proxy del sistema; cancelar cierra el handle
    desde otro hilo, que WinHTTP admite). `anthropic-version: 2026-10-21`, alias → ids
    (`opus` → `claude-opus-5-5`…), `output_config.effort` donde el modelo lo admite y
    `fallbacks: "default"` (beta `server-side-fallback-2026-07-01`) en Opus 5.5 / Sonnet 5.5 /
    Fable; `stop_reason: "refusal"` se informa. La API key vive en el **Administrador de
    credenciales** (`ai/credentials.rs`, credencial genérica `Brisa/anthropic-api-key`, de este
    usuario en este equipo): se escribe desde Configuración → IA, se lee en Rust al consultar y
    el frontend solo ve sus últimos 4 caracteres.
  - Una consulta = un hilo `ai-<id>`; eventos `delta`/`status` y exactamente un `done` o
    `error` (códigos: `not-installed`, `outdated`, `auth`, `limit`, `no-key`, `api-key`,
    `rate-limit`, `overloaded`, `network`, `refusal`, `timeout`, `cancelled`, `invalid`,
    `failed`, `disabled`). Cada código tiene título y cómo resolverlo (`lib/aiErrors.ts`).
    Pertenecen a la página como las sesiones: recargar o cerrar las cancela.
- **Variables de sesión anidada** (`pty/nested.rs`): `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`,
  `CLAUDE_CODE_SSE_PORT`, `CLAUDE_CODE_SESSION_ID`… (la lista es la que Claude Code 2.1.x pone
  en sus hijos) se quitan de las shells **y** de `claude -p`. Hasta la 7B solo lo hacía la e2e
  al lanzar la app (las shells las heredaban). Las de configuración (`CLAUDE_CONFIG_DIR`,
  `CLAUDE_CODE_GIT_BASH_PATH`, `CLAUDE_CODE_USE_BEDROCK`…) quedan.
- **Redacción de secretos** (`lib/redact.ts`, puro, con tests de formatos reales): todo lo que
  se envía pasa por ahí, pieza por pieza (comando, salida, carpeta, rama, pregunta). Formatos
  conocidos (GitHub `ghp_`/`gho_`/`github_pat_`, Anthropic `sk-ant-…`, OpenAI `sk-proj-…` y
  legacy, AWS, Google, Slack, Stripe, npm, PyPI, Hugging Face, SendGrid, JWT, claves privadas,
  webhooks, firmas SAS), credenciales por contexto (connection strings de SQL Server / Azure /
  ODBC, URLs con usuario:clave, `NOMBRE=valor` / `"clave": "valor"` / `$env:X = '…'` / `set`
  / `export` con un nombre sensible, flags `--password`/`-Token`, `ConvertTo-SecureString`,
  `Authorization`/`Bearer`), **archivos .env enteros** (el comando lee un `.env*`, o la salida
  tiene forma de .env: se ocultan todos los valores) y listados de entorno (`gci env:`, `set`,
  `env`, `printenv`: los valores de nombres sensibles), y cadenas largas con forma de token por
  entropía (no SHAs de git, UUIDs, digests ni identificadores CamelCase). Queda
  `[REDACTED:<tipo>]`. Después Rust reemplaza los valores de las variables de entorno sensibles
  del proceso (`ai/secrets.rs`: `echo $env:MI_TOKEN` no tiene formato conocido; los valores
  nunca salen de Rust). `ai.redact`: patrones propios (regex) para nombres de clientes, dominios
  internos…
- **Contexto** (`lib/aiPrompts.ts`, puro): sistema, shell (perfil y tipo), carpeta, rama de git
  (del store o `git_status` con 2,5 s de tope), comando, código de salida y la salida recortada
  (`trimOutput`: líneas repetidas colapsadas; si es larga, el principio, el final y las líneas con
  errores del medio, con marcas de lo omitido; tope de caracteres que conserva el final). Las
  salidas van en un fence más largo que cualquier racha de backticks de adentro.
- **"Ver qué se envía"** (`AiContextDialog`): el payload exacto (system prompt + mensajes, ya
  redactados, con el resumen de lo oculto). Antes (botón del chat y de la barra, con el texto
  escrito) o después (cada respuesta, "Ver qué se envió").
- **Insertar, nunca ejecutar** (`lib/aiSafety.ts`, puro): `prepareInsert` saca todo carácter de
  control (ESC, CR, C1: una respuesta no puede meter un Enter ni cerrar un bracketed paste) y no
  deja saltos de línea salvo que el programa pidió bracketed paste; si no, une las líneas (`; `,
  ` & ` en cmd, continuaciones `` ` `` `\` `^` y tuberías respetadas). `insertCommand` además se
  niega con un comando corriendo (OSC 133), un agente o un programa de pantalla completa.
  `destructiveReasons`: borrados recursivos (rm -r, Remove-Item -Recurse y alias, rd/del /s,
  comodines, raíz o home), `git reset --hard`, `git clean -f`, `git push --force`/`+rama`/
  `--delete`, `git branch -D`, `checkout/restore .`, formateos y particiones, `dd of=`,
  registro (`reg add/delete`, `*-ItemProperty HKLM:`), apagar/reiniciar, `bcdedit`, política de
  ejecución, permisos masivos, `DROP`/`TRUNCATE`/`DELETE` sin `WHERE`, `docker … prune`,
  `kubectl delete`, `terraform destroy`, `| iex` y `curl | sh`: advertencia roja visible antes
  de insertar.
- **Panel** (`AiPanel.tsx`, a la derecha, ancho arrastrable): una conversación corta por panel
  de terminal (la del panel activo; se borra al cerrar el panel). "Explicar / arreglar" abre el
  panel con la respuesta en streaming. Cada bloque de código de una respuesta es una tarjeta con
  "Insertar" y "Copiar". Adjuntos: "Agregar al chat" desde el menú de un bloque (se copia el
  bloque al agregarlo); van en la siguiente pregunta. Historial: el primer mensaje y los últimos
  6 (para el CLI, la conversación escrita en un solo prompt). Esc (en el panel) o "Cancelar"
  cancela; "Pensando…" mientras no llega texto. **Esc en la terminal** (`ai.cancel`, alcance
  terminal, `passthrough`) cancela la consulta en curso de ese panel solo si la shell está libre
  en su prompt según la integración (sin comando, agente ni pantalla completa; en cmd, nunca): si
  no, la tecla sigue al programa.
- **Barra** (`AiCommandBar.tsx`, `Ctrl+I` = `ai.command`): sobre el panel activo. Enter propone
  (esfuerzo bajo; el prompt pide un bloque de código y una línea de explicación, o "No: motivo");
  Enter otra vez inserta sin ejecutar; cambiar el texto y Enter pide otro; Esc cancela la consulta
  en curso o cierra. La barra es de su panel: si cambia el panel activo (otra tab, otro panel) se
  cierra y el teclado va a la terminal nueva. Con `ai.enabled: false` `Ctrl+I` llega al programa
  (es Tab).
- **Estado** (`store/ai.ts`): panel, ancho, conversaciones por panel, barra y diálogo. Ids de
  consulta, cancelaciones y el batching por frame de los deltas en `lib/aiActions.ts`. IPC solo
  en `lib/aiApi.ts`.
- **Settings** `ai`: `enabled`, `provider`, `model` (default `opus`), `claudePath`, `redact`.
  Configuración → IA: además "Verificar Claude Code" (`claude --version` y `claude auth status
  --json`: local, no le pregunta nada a ningún modelo) y la API key (guardar/borrar).
- **e2e y tests**: el agente falso tiene modo `print` (`claude -p`: el stream-json real, errores
  de login/límite/crash/versión vieja, respuesta lenta para cancelar, y un log por corrida con
  argv, cwd, entorno, system prompt y stdin). La e2e lo usa por un `.cmd` en
  `BRISA_CLAUDE_PATH`, levanta una API falsa (`BRISA_ANTHROPIC_BASE_URL`) y usa una credencial
  descartable (`BRISA_CREDENTIAL_TARGET`, borrada al final; verificada con `cmdkey`). Las tres
  variables solo se leen en builds de desarrollo.

## Estructura

```
CLAUDE.md
index.html, vite.config.ts, tsconfig.json, package.json
src/                        Frontend (solo render + input)
  main.tsx, App.tsx (título de ventana = tab activa), styles.css
  components/TabBar.tsx     Barra de tabs (y de título: arrastre, doble clic) + DndContext (TabItem, GroupChip, RenameInput)
  components/WindowControls.tsx  Minimizar / maximizar / cerrar de la barra propia (estado de la ventana nativa)
  components/ContextMenus.tsx  Menús de tab y de grupo (primitivas en Menu.tsx)
  components/ConfirmDialog.tsx Confirmación al cerrar tabs con procesos
  components/Workspace.tsx  Todos los TerminalPane montados y posicionados + divisores + SearchBar
  components/TerminalPane.tsx  Una instancia xterm + addons + sesión por pane (memo, nunca se recrea)
  components/PaneDivider.tsx   Divisor arrastrable (doble clic: igualar)
  components/StatusBar.tsx  cwd del panel activo, rama de git, último comando, avisos (integración, settings.json, layouts.json)
  components/Sidebar.tsx    Explorador: breadcrumbs, fijar, ver ocultos, aviso, ancho redimensionable
  components/FileTree.tsx   Árbol virtualizado: clic (cd / navegar / insertar), arrastrar a un panel, renombrar
  components/ProfileIcon.tsx   Ícono de un perfil (monogramas incluidos o emoji del usuario)
  components/SettingsPage.tsx  Ctrl+,: navegación, avisos del archivo, abrir settings.json
  components/settings/      Secciones (GeneralSections, ThemesSection, ProfilesSection, AgentsSection,
                            AiSection, KeybindingsSection, SessionSection) y Controls
  components/CommandPalette.tsx  Ctrl+Shift+P: búsqueda difusa, recientes primero, atajos a la derecha
  components/SaveLayoutDialog.tsx  Guardar la tab o la ventana como layout (nombre + comando por panel)
  components/Toast.tsx      Aviso breve abajo (layout guardado, comando inicial que no se escribió)
  components/AgentBadge.tsx Agente del panel y su estado (arriba a la derecha)
  components/MultiAgentDialog.tsx  Preset multi-agente: paneles, agente de cada uno, worktrees
  components/AiPanel.tsx    Ctrl+Shift+I: chat corto por panel, respuestas de "Explicar / arreglar", adjuntos
  components/AiCommandBar.tsx  Ctrl+I: lenguaje natural a comando sobre el panel activo (Enter propone / inserta)
  components/AiAnswer.tsx   Respuesta de la IA: párrafos y tarjetas de comando (Insertar sin ejecutar, aviso destructivo)
  components/AiErrorBox.tsx Error de una consulta con cómo resolverlo
  components/AiContextDialog.tsx  "Ver qué se envía": el payload exacto, ya redactado
  config/schema.ts          Mini librería de esquema: valida, defaults, tipos inferidos, JSON Schema
  config/settingsSchema.ts  El esquema de settings.json (+ settingsSchema.test.ts)
  config/keybindings.ts     Acciones, teclas por defecto, parseo, eventos → teclas, conflictos, keybindings (+ test)
  config/themes.ts          Temas incluidos, import (propio / Windows Terminal), colores de UI (+ test)
  config/profiles.ts        Perfiles detectados + los de settings.json, por defecto (+ test)
  config/colors.ts          Colores de tabs/grupos (variables CSS del tema)
  lib/pty.ts                Punto de IPC de las terminales; wrappers tipados de los comandos
  lib/fsApi.ts              Punto de IPC del explorador (listar, watcher, git, operaciones, drop nativo)
  lib/settingsApi.ts        Punto de IPC de los archivos de config (settings, sesión, layouts) y del aspecto de la ventana
  lib/settingsText.ts       JSONC: parseo con línea/columna y ediciones que conservan el formato (puro)
  lib/settingsSync.ts       Carga, vigila, aplica y guarda settings.json; migración; explorador ↔ settings
  lib/settingsActions.ts    Importar/borrar temas, editar perfiles, asignar/reasignar/restaurar atajos
  lib/sessionSync.ts        Arranque (settings + shells + layouts + sesión → restaurar), guardado de session.json
  lib/layoutsSync.ts        Carga, vigila y guarda layouts.json (ediciones que conservan el formato)
  lib/layoutActions.ts      Guardar la tab/ventana como layout, abrir uno (reemplaza una tab sin usar)
  lib/initialCommands.ts    Comandos iniciales de un layout: se escriben al llegar el prompt (OSC 133;B)
  lib/fuzzy.ts              Búsqueda difusa de la paleta (+ fuzzy.test.ts)
  lib/paletteItems.ts       Lo que ofrece la paleta: acciones, tabs, paneles, perfiles, temas, layouts
  lib/appActions.ts         Qué hace cada acción (desde su atajo o la paleta)
  lib/blocks.ts             BlockTracker: bloques de comandos (OSC 133), margen, navegación, texto
  lib/blockActions.ts       Menú de un bloque (copiar, volver a ejecutar) y la API de bloques (contexto de la IA)
  lib/agentMonitor.ts       Agentes por panel (trabajando/esperando/terminado) y notificaciones nativas
  lib/multiAgent.ts         Preset multi-agente, worktrees por panel y su limpieza al cerrar
  lib/aiApi.ts              Punto de IPC de la IA (consultas con canal, cancelar, estado, API key, entorno)
  lib/aiActions.ts          Explicar / chat / comando: contexto, redacción, envío en streaming, cancelar, insertar
  lib/aiPrompts.ts          Prompts, recorte de salidas, historial del chat, parseo de respuestas (puro, + test)
  lib/aiSafety.ts           Comandos destructivos e inserción sin ejecutar (puro, + test)
  lib/redact.ts             Redacción de secretos antes de enviar nada (puro, + test con formatos reales)
  lib/aiErrors.ts           Qué decir ante cada error de la IA y cómo resolverlo
  lib/appearance.ts         Tema → variables CSS y ventana (Mica/Acrylic); opciones de cada terminal
  lib/ligatures.ts          Ligaduras con un character joiner (+ test)
  lib/explorerModel.ts      Lógica pura del explorador, breadcrumbs que entran (+ explorerModel.test.ts)
  lib/windowChrome.ts       Barra propia: minimizar/maximizar/cerrar, maximizada, foco, resize de arriba, titleBar en vivo
  lib/explorerData.ts       Listados perezosos con generación, watcher de lo visible, refresco de git
  lib/explorerActions.ts    cd con guardas, insertar rutas, acciones del menú contextual
  lib/dropTarget.ts         Panel bajo el puntero, resaltado, archivos soltados desde otras apps
  lib/terminalSession.ts    Conecta un Terminal de xterm con una sesión PTY (entrada en cola, restart)
  lib/inputQueue.ts         Cola de entrada por sesión: orden, un envío a la vez, reintentos (+ test)
  lib/shellIntegration.ts   Handlers OSC 7/9;9/133/633 → ShellEvent (parsers puros + shellIntegration.test.ts)
  lib/paths.ts              Nombre de carpeta y acortado de rutas (~, …) para la UI
  lib/terminalRegistry.ts   PaneId → { term, fit, search, session } (objetos imperativos)
  lib/tabActions.ts         Cerrar con confirmación, cerrar ventana con la última tab, foco
  lib/appShortcuts.ts       Despacho de todos los atajos (un listener en captura sobre window)
  lib/keybindings.ts        copySelection (copiar y limpiar la selección)
  lib/clipboard.ts          navigator.clipboard con fallback
  lib/renderer.ts           GpuRenderer: WebGL solo mientras se ve, fallback al DOM, loseContext al ocultar
  lib/paneGeometry.ts       Rectángulos del layout → CSS de panes y divisores (gap, mínimo en px)
  lib/devHooks.ts           Solo dev: window.__terminal / __workspace / __ui / __settings / __layouts /
                            __session / __pendingCommands / __ai / __aiQuery para e2e
  store/workspaceModel.ts   Modelo puro de tabs/grupos/panes (+ workspaceModel.test.ts)
  store/workspace.ts        zustand sobre el modelo (ids, acciones; vacío hasta restaurar la sesión)
  store/layoutModel.ts      Formato de sesión y layouts: snapshot, validación, reconstrucción (puro, + test)
  store/layouts.ts          zustand: layouts.json en uso (lista válida, estado, avisos)
  store/session.ts          zustand: sesión lista para montar terminales, comandos recientes de la paleta
  store/keymap.ts           Atajos en uso (defaults + settings), conflictos, etiquetas para menús
  store/ui.ts               zustand: renombrado, menú, diálogo, búsqueda, configuración, paleta, layout, toast
  store/chrome.ts           zustand: barra nativa o propia, maximizada, activa, hover/presionado de los botones
  store/system.ts           zustand: carpeta del usuario y shells detectadas (system_info)
  store/explorer.ts         zustand: estado del explorador (lo persistente va a settings.json)
  store/git.ts              zustand: estado de git por repositorio + refreshGit (un proceso a la vez)
  store/settings.ts         zustand: settings en uso, estado del archivo, avisos, zoom de la sesión
  store/profiles.ts         Perfiles en uso (detectados + settings), memoizados
  store/ai.ts               zustand: panel de IA, conversaciones por panel, barra Ctrl+I, diálogo "qué se envía"
src-tauri/
  src/lib.rs                Builder de Tauri, ventana principal (transparente solo si se pide; sin barra de
                            Windows salvo appearance.titleBar: native), ciclo de vida
  src/titlebar.rs           Ventana nativa sobre los botones de la barra propia (Snap Layouts) y titleBar en vivo
  app.manifest, build.rs    Manifiesto de la app: el de Tauri + Windows 8+ (ventanas hijas layered)
  src/commands.rs           Comandos Tauri finos: validan y delegan en PtyManager
  src/explorer_commands.rs  Comandos del explorador (spawn_blocking) y su canal del watcher
  src/settings.rs           Archivos de config: carpeta (+ migración de dev.terminal.desktop), lectura,
                            escritura atómica, JSONC mínimo (sin Tauri)
  src/settings_commands.rs  Comandos de los archivos de config y del aspecto de la ventana (Mica/Acrylic)
  src/notifications.rs      Toasts de WinRT (AUMID registrado, clic → ventana al frente + panel), log de e2e
  src/worktree.rs           Worktrees del preset multi-agente: crear, estado, borrar (solo los de Brisa)
  src/ai_commands.rs        Comandos de la IA (configurar, consultar con canal, cancelar, estado, API key)
  src/ai/                   Capa de IA sin Tauri: manager.rs (hilos, cancelación, dueños), claude_cli.rs
                            (claude -p aislado en un Job Object), anthropic.rs + http.rs (API por WinHTTP),
                            credentials.rs (Administrador de credenciales), stream.rs (stream-json y SSE),
                            secrets.rs (valores de variables de entorno sensibles)
  src/explorer/             list.rs, watch.rs, git.rs, ops.rs (sin Tauri; tests unitarios)
  src/pty/manager.rs        Registro de sesiones (create/write/resize/close/close_owned_by/shutdown)
  src/pty/session.rs        ConPTY + hilos reader/flusher/writer/waiter + batching
  src/pty/job.rs            Job Object: miembros, KILL_ON_JOB_CLOSE, kill verificado (solo Windows)
  src/pty/nested.rs         Variables de una sesión de Claude Code que no pasan a shells ni a claude -p
  src/pty/teardown.rs       Cierre selectivo: consola muere, apps con ventana sobreviven
  src/pty/agents.rs         Shift+Enter por contexto: detección de agentes de IA y secuencias
  src/pty/procs.rs          Tabla de procesos (Toolhelp), dueños de ventanas, command lines (Windows)
  src/pty/shell.rs          Perfiles detectados (pwsh, powershell, cmd, Git Bash, WSL), ShellSpec →
                            qué lanzar con qué integración, %VARIABLES%, cwd y fallback a %USERPROFILE%
  src/pty/wsl.rs            Distros WSL desde el registro (sin lanzar wsl.exe)
  src/pty/platform.rs       Build de Windows (RtlGetVersion) para `pty_backend`
  resources/shell-integration/  powershell.ps1 y bash.sh (recursos del bundle)
  tests/pty.rs              Tests de integración con procesos reales (PowerShell/Git Bash/ConPTY)
  tests/explorer.rs         Listado (.gitignore, ocultos, 5000 archivos) y git real
  tests/worktree.rs         Worktrees con git real (crear, cambios, ramas, solo los de Brisa)
  tests/ai.rs               IA con el claude falso (.cmd) y una API falsa local: streaming, aislamiento,
                            errores, cancelación del árbol, credenciales, IA apagada
e2e/
  run.mjs                   E2E sobre la app real vía CDP de WebView2 (`npm run e2e`)
  fake-agent.mjs            Agente de IA falso (claude/codex/gemini según el exe; /work, /bell, /osc9,
                            /osc777, /after N; modo print = claude -p: ver "Pruebas con agentes")
  sink.mjs                  Programa en modo raw que guarda byte a byte lo que recibe (estrés de entrada)
  win.ps1                   Resize/cierre de la ventana de la app por PID (Win32)
  caption.ps1               Botones de la barra propia por mensajes Win32: hit-test (Snap Layouts),
                            presionar, clic, maximizada (DPI aware; nunca mueve el mouse real)
  recycle.ps1               Verifica que lo borrado por la e2e está en la papelera y lo saca de ahí
  artifacts/                Capturas de la página (CDP) y logs de `tauri dev` (ignorado por git)
```

## Comandos

```powershell
npm install
npm run tauri dev                       # app en modo desarrollo (Vite + cargo run)
npm run build                           # typecheck (tsc) + build del frontend
npm test                                # tests unitarios del frontend (node --test, sin dependencias)
npm run tauri build -- --no-bundle      # exe release en src-tauri/target/release/
cd src-tauri; cargo fmt --check; cargo clippy --all-targets -- -D warnings; cargo test
npm run e2e:smoke                       # lo esencial (~105 s): en cada cambio
npm run e2e                             # todas las etapas (~5 min): para cerrar una fase
npm run e2e -- tabs,groups              # solo algunas etapas
E2E_ATTACH=1 npm run e2e -- tabs        # contra una app ya abierta con CDP en el puerto 9223
```

Los tests unitarios de TypeScript (`*.test.ts`) corren con el type stripping nativo de Node 24:
solo sintaxis borrable (`erasableSyntaxOnly`), imports con extensión `.ts` y quedan fuera del
`tsconfig` de la app. Los módulos puros que se importan entre sí en runtime (`config/*.ts`,
`lib/settingsText.ts`, `store/layoutModel.ts`) también usan la extensión `.ts` en sus imports
(`allowImportingTsExtensions`); `jsonc-parser` se importa igual en Node y en Vite.

`npm run e2e` usa una carpeta de configuración descartable (`BRISA_CONFIG_DIR` dentro de la
carpeta temporal de la corrida): nunca toca el `settings.json`, los layouts ni la sesión del
usuario (y sin la carpeta del usuario tampoco corre la migración del nombre viejo). Con
`E2E_ATTACH=1` las etapas de configuración se saltean si la app no usa esa carpeta. La etapa
`reopen` cierra la ventana con la X y relanza `tauri dev` (log en `tauri-dev-2.log`) para ver
qué vuelve. Las notificaciones nativas de la suite van a un archivo (`BRISA_NOTIFY_LOG`), nunca
a la pantalla del usuario; la etapa `multiagent` crea un repo de git descartable.

`npm run e2e` necesita los puertos 1420 (Vite) y 9223 (CDP) libres. Abre una ventana real de la
app, abre y cierra ventanas de `charmap.exe` (prueba de apps con ventana) y usa el portapapeles
(lo restaura al terminar). `cargo test` también abre `charmap` brevemente. Capturas en
`e2e/artifacts/`.

## Capturas de pantalla (regla obligatoria)

- **Nunca** capturar la pantalla completa ni otras ventanas: el usuario trabaja en su máquina y
  lo que tenga abierto es suyo.
- Para verificar algo visual, capturar **solo la ventana de la app por su handle**. Las capturas
  de la e2e (`page.screenshot` por CDP) son el contenido de la página de la app, nada más: valen.
- Lo que la página no muestra (Mica/Acrylic los dibuja DWM, la barra de título) solo se captura
  si se puede garantizar que sale únicamente la ventana de la app (por su HWND, sin lo que tenga
  encima). Si no se puede garantizar, **no se captura**: se verifica de otra forma (consultando a
  DWM, por ejemplo) y lo visual queda como paso manual en el smoke test.

## Pruebas con agentes de IA (regla obligatoria)

- **Ninguna prueba (e2e, de integración ni manual automatizada) envía input a un `claude`,
  `codex` o `gemini` real**, ni siquiera tipear sin Enter: cualquier interacción puede consumir
  uso de la cuenta del usuario (y un agente en *auto mode* puede ejecutar cosas).
- Para probar comportamiento con agentes se usa `e2e/fake-agent.mjs`: editor de línea en raw
  mode, bracketed paste, la secuencia de salto de línea de cada agente y "Ctrl+C dos veces para
  salir". Se ejecuta con un `node.exe` enlazado como `claude.exe` / `codex.exe` / `gemini.exe`,
  así la detección de agentes se prueba con el mismo nombre de imagen que el real. Para los
  indicadores y notificaciones entiende `/work N` (spinner = trabajando), `/bell`,
  `/osc9 texto`, `/osc777 título|texto` y `/after N <línea>` (lo mismo, N segundos después:
  la prueba mientras tanto oculta el panel). El preset multi-agente de la e2e corre el agente
  falso poniendo `agents.commands` en su settings.json descartable.
- **IA** (Fase 7B): ninguna prueba lanza `claude -p` real ni llama a la API real de Anthropic.
  El agente falso tiene modo `print` (`node fake-agent.mjs print <args>`): habla el stream-json
  de claude 2.1.x (capturado del real), **exige** cada flag de aislamiento (si falta uno,
  responde un error), simula sin sesión, límite, crash, versión vieja y respuestas lentas
  (`FAKE_AUTH_ERROR`, `FAKE_LIMIT`, `FAKE_CRASH`, `FAKE_UNKNOWN_OPTION`, `FAKE_SLOW`,
  `FAKE_DESTRUCTIVE` en el prompt; sesión por `FAKE_CLAUDE_STATE`) y anota cada corrida en
  `FAKE_CLAUDE_LOG`. La e2e se lo da a la app como su claude desde el arranque
  (`BRISA_CLAUDE_PATH`, solo dev: ni antes de leer settings.json puede correr otro), la API es
  un servidor local (`BRISA_ANTHROPIC_BASE_URL`) y la key va a una credencial descartable
  (`BRISA_CREDENTIAL_TARGET`). `tests/ai.rs` hace lo mismo sin la app. Probar con Claude Code
  real queda a criterio del usuario, a mano.
- `run()` en `e2e/run.mjs` se niega a tipear si el cursor no está en un prompt de PowerShell
  libre o si la terminal activa no tiene el foco; `runIdle()`, si la integración no dice que la
  shell está libre (ningún comando corriendo): un fallo nunca debe terminar mandando texto a un
  programa ajeno (ni perder teclas).

## Convenciones

**Generales**
- Identificadores y comentarios de código en inglés; documentación y textos de UI en español.
- Comentarios solo para el *por qué* no obvio (quirks de ConPTY, orden de teardown, etc.).

**Rust**
- Los comandos de Tauri son finos: convierten argumentos y delegan en `pty::PtyManager`. La lógica
  vive en `pty/`, que **no depende de Tauri** (usa el trait `SessionEvents`) para poder testearla.
- Sin `unwrap()`/`expect()` fuera de tests. Errores con `PtyError` (thiserror), serializados como
  string hacia el frontend. Mutex envenenados se recuperan con `PoisonError::into_inner`.
- Nunca bloquear el hilo principal: spawn en `spawn_blocking`, teardown en un hilo aparte.
- Código específico de Windows detrás de `#[cfg(windows)]`, en su propio módulo.
- `cargo fmt` + `cargo clippy --all-targets -- -D warnings` limpios.

**TypeScript / React**
- `strict` + `noUncheckedIndexedAccess`; prohibido `any`.
- Todo IPC pasa por `src/lib/pty.ts` (terminales) y `src/lib/fsApi.ts` (explorador). Los
  componentes no llaman a `invoke` directamente.
- Las instancias de `Terminal` (xterm) y addons viven en `lib/terminalRegistry.ts`, **nunca** en
  zustand ni en estado de React (son imperativas y no serializables). zustand guarda solo estado
  serializable: `workspace` (tabs/grupos/panes), `ui` (efímero), `settings`, `system`,
  `explorer` y `git`. Lo imperativo del explorador (id del watcher, generaciones de pedidos,
  timers) vive en módulos de `lib/`.
- Las reglas de tabs y grupos van en `store/workspaceModel.ts` como funciones puras con tests;
  el store solo las envuelve. Devolver el mismo objeto si nada cambió (evita re-renders).
- Componentes funcionales, uno por archivo, PascalCase. Excepción: piezas chicas y privadas de un
  mismo widget (`Menu`/`MenuItem`, `ContextMenus` con sus dos menús).
- Todo efecto que crea recursos (terminal, sesión, observers) los libera en el cleanup y es seguro
  ante el doble montaje de `StrictMode` en dev.

## Regla de fases

**Cada fase tiene que compilar y funcionar antes de empezar la siguiente.** Una fase está
terminada solo si:

1. `npm run build` y `npm test` pasan sin errores.
2. `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings` y `cargo test` pasan.
3. `npm run e2e` pasa completo (cubre automáticamente casi todo el smoke test de abajo).

Durante el trabajo, después de **cada cambio**: `npm run e2e:smoke` (arranque, Ctrl+C,
Shift+Enter con agentes falsos, tabs, paneles, shell integration, estrés de entrada, explorador,
settings.json en vivo, atajos configurables, sesión, bloques y cierre; ~105 s, tiene que quedar
por debajo de 2 min). La suite completa (`npm run e2e`, ~5 min) se corre para cerrar la fase. Mientras corre cualquiera de las dos, no tocar `src/`
ni `src-tauri/`: el HMR de Vite o el rebuild de `tauri dev` reinician la app a mitad de camino.
Cada etapa imprime su duración (`== etapa: N s`).

Si algo queda pendiente, se anota en "Estado" antes de seguir. No se apilan fases sobre una rota.

### Smoke test manual

- [ ] Arranca PowerShell (`pwsh` si existe, si no `powershell.exe`) ocupando toda la ventana.
- [ ] Colores: `Write-Host rojo -ForegroundColor Red`; truecolor: ``"`e[38;2;255;100;0mnaranja`e[0m"`` (pwsh).
- [ ] Programas interactivos: `& "C:\Program Files\Git\usr\bin\vim.exe"` y `nano.exe`.
- [ ] `Ctrl+C` sin selección interrumpe (`ping -t 127.0.0.1`); con selección copia.
- [ ] Pegar con `Ctrl+V` / `Ctrl+Shift+V` / `Shift+Insert` (multilínea respeta bracketed paste).
- [ ] Redimensionar la ventana: `[Console]::WindowWidth` coincide con las columnas visibles.
- [ ] Un agente (el falso de `e2e/`) arranca, recibe input y sale con `Ctrl+C` dos veces.
  Probar a mano con un agente real queda a criterio del usuario, nunca automatizado.
- [ ] Cerrar la ventana no deja `powershell`/`pwsh`/hijos de consola vivos (Administrador de
  tareas), pero una app con ventana lanzada desde la terminal (`notepad`, `code .`) sigue abierta.
- [ ] `Shift+Enter` en PowerShell agrega una línea (`>>`) en vez de ejecutar.
- [ ] Tabs: abrir, cambiar, renombrar, arrastrar y agrupar; al volver a una tab, el scrollback
  sigue ahí y el tamaño es el correcto. Cerrar una tab con un dev server pide confirmación.
- [ ] Paneles: dividir en ambas direcciones, arrastrar divisores, zoom; en cada panel
  `[Console]::WindowWidth` coincide con su ancho visible.
- [ ] Shell integration: `cd` a una carpeta con espacios y tildes → la status bar (tooltip con la
  ruta completa) y el subtítulo de la tab la muestran; dividir, duplicar y nueva tab abren ahí.
  `cmd /c exit 3` muestra ✗ 3; cerrar la tab durante `Start-Sleep 30` pide confirmación. Con el
  prompt de oh-my-posh/starship (si se usan) todo sigue igual.
- [ ] Explorador: `Ctrl+B` lo muestra/oculta; sigue al panel activo; clic en carpeta hace `cd`
  (no si hay un comando corriendo); clic en archivo inserta la ruta. **A mano** (la e2e no abre
  apps externas ni hace un arrastre real del sistema): "Abrir en VS Code", "Abrir en el
  Explorador de Windows" y arrastrar un archivo desde el Explorador de Windows a un panel.
- [ ] Configuración: `Ctrl+,` abre la pantalla; cambiar la fuente o el tema se ve al instante;
  editar `settings.json` en VS Code (botón "Abrir settings.json") con un error deja todo como
  estaba y muestra "⚠ settings.json"; al corregirlo se aplica. "▾" lista PowerShell, cmd, Git
  Bash (y WSL si hay); cmd abre en la carpeta del panel y el explorador lo sigue. **A mano**:
  Mica/Acrylic (`appearance.backdrop`) y opacidad < 100, reiniciando la app una vez; soltar un
  `.json` de tema desde el Explorador de Windows en Temas.
- [ ] Atajos: en Configuración → Atajos, agregar uno (se graba la tecla), quitar `Ctrl+B` (llega
  al programa), uno repetido ofrece "Reasignar"; "Restaurar los valores por defecto".
- [ ] `Ctrl+Shift+P`: buscar "ntab", "tema dracula", una tab por su nombre; lo último usado sale
  primero.
- [ ] Sesión: tabs con nombre y color, un grupo colapsado, una tab dividida y `cd` en un panel;
  cerrar con la X y volver a abrir → todo igual (sin el contenido). Con `session.restore: false`,
  una tab nueva.
- [ ] Layouts: "▾" → "Guardar la tab como layout…" con un comando (`npm run dev`); abrirlo desde
  la paleta → el comando se escribe recién cuando aparece el prompt. **A mano**: "Abrir
  layouts.json" lo abre en VS Code.
- [ ] Bloques: varios comandos, uno con `cmd /c exit 3` (marca roja); pasar el mouse, copiar la
  salida, volver a ejecutar; `Ctrl+↑` / `Ctrl+↓`. En vim, sin marcas.
- [ ] Agentes (el falso de `e2e/`, o uno real **a mano**, a criterio del usuario): la tab y el
  panel muestran trabajando / esperando / terminado. **A mano**: con el panel en otra tab, una
  notificación de Windows real; el clic trae Brisa al frente con ese panel. "Abrir multi-agente
  aquí" en un repo con worktrees; al cerrar la tab, los limpios se borran y uno con cambios pregunta.
- [ ] IA (automatizado con el claude falso y la API falsa; **a mano y a criterio del usuario**
  con Claude Code real o una API key real): un comando que falla → "Explicar / arreglar" →
  respuesta en el panel e "Insertar" lo escribe sin ejecutar; `Ctrl+I` con "matá el proceso que
  usa el puerto 3000"; "Ver qué se envía" con un token en la salida (sale `[REDACTED:…]`);
  Configuración → IA → "Verificar Claude Code"; `ai.enabled: false` → nada de IA.
- [ ] Barra de título propia (**a mano**: lo que dibuja Windows no sale en las capturas de la
  página): pasar el mouse por maximizar muestra los Snap Layouts; arrastrar la ventana desde el
  espacio vacío (incluido llevarla a un borde de la pantalla); doble clic maximiza y restaura;
  redimensionar desde los cuatro bordes; los botones con el tema claro y el oscuro; con
  `appearance.titleBar: "native"` vuelve la barra de Windows sin reiniciar.
- [ ] Diseño: `appearance.cornerRadius` 0 y 8 con tres temas (tabs, paneles divididos, explorador,
  panel de IA, menús, paleta, configuración); el explorador con una ruta larga colapsa en "…".
- [ ] Primer arranque tras el renombre: la configuración de `%APPDATA%\dev.terminal.desktop`
  aparece en `%APPDATA%\dev.brisa.desktop` (temas importados incluidos).

## Atajos

Todos los atajos de la tabla (salvo los del mouse y los internos de un widget) son los
**valores por defecto** y se cambian en Configuración → Atajos o en `keybindings` de
settings.json (ver "Atajos configurables"). Sin atajo por defecto, solo desde la paleta: cerrar
tab, cerrar las demás, duplicar, quitar del grupo, igualar paneles, seleccionar todo, limpiar,
ver ocultos, guardar layouts, abrir settings.json / layouts.json, abrir multi-agente aquí, explicar el
último comando que falló (IA).

| Atajo | Acción |
|---|---|
| `Ctrl+Shift+P` | Paleta de comandos (acciones, tabs, paneles, perfiles, temas, layouts) |
| `Ctrl+,` | Configuración (otra vez o `Esc`: cerrar) |
| Arrastrar / doble clic en el espacio vacío de la barra de tabs | Mover la ventana / maximizar o restaurar (barra propia) |
| `Ctrl+I` | IA: lenguaje natural a comando sobre el panel activo (`Enter` propone, `Enter` otra vez inserta sin ejecutar, `Esc` cancela) |
| `Ctrl+Shift+I` | IA: panel de chat (también recibe "Explicar / arreglar"; `Esc` cancela la consulta en curso) |
| `Ctrl+Shift+T` / botón `+` | Nueva tab con el perfil por defecto (en su carpeta inicial o la del panel activo) |
| Botón `▾` junto al `+` | Nueva tab con cualquier perfil; abrir y guardar layouts; paleta; Configuración |
| `Ctrl+B` | Mostrar / ocultar el explorador de archivos |
| Clic en carpeta / archivo del explorador | `cd` en el panel activo (si está libre) o solo navegar (según la configuración) / insertar la ruta |
| Arrastrar del explorador (o del Explorador de Windows) a un panel | Pegar la ruta con comillas en ese panel |
| `F2` / `Supr` con el árbol enfocado | Renombrar / mover a la papelera |
| `Ctrl+Shift+W` | Cerrar el panel activo; si es el último, la tab (confirma si hay procesos además de la shell) |
| `Alt+Shift+D` / `Alt+Shift+-` | Dividir el panel a la derecha / hacia abajo |
| `Alt+←↑→↓` | Mover el foco al panel en esa dirección |
| `Ctrl+Shift+Z` | Maximizar / restaurar el panel activo dentro de la tab |
| Clic en un panel | Enfocarlo |
| Arrastrar un divisor / doble clic | Redimensionar / repartir en partes iguales |
| `Shift`+clic derecho en un panel, `Shift+F10` | Menú del panel: dividir, maximizar, igualar, cerrar (con clic derecho en modo menú, además copiar/pegar/seleccionar todo/buscar/limpiar) |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Tab siguiente / anterior (salta las de grupos colapsados) |
| `Ctrl+1`…`Ctrl+8` / `Ctrl+9` | Ir a la tab N / a la última (expande su grupo si está colapsado) |
| `F2`, doble clic en la tab | Renombrar (`Enter` guarda, `Escape` cancela, vacío vuelve al título del proceso) |
| `Ctrl+Shift+G` | Nuevo grupo con la tab actual |
| Clic derecho en una tab | Renombrar, color, duplicar, mover a grupo, cerrar, cerrar las demás |
| Clic en el chip del grupo | Colapsar / expandir (clic derecho: renombrar, color, desagrupar, cerrar grupo) |
| Clic del medio en una tab | Cerrar |
| `Ctrl+C` | Copia si hay selección; si no, envía `^C` |
| `Ctrl+Shift+C`, `Ctrl+Insert` | Copiar |
| `Ctrl+V`, `Ctrl+Shift+V`, `Shift+Insert` | Pegar |
| Clic derecho | Copia si hay selección; si no, pega (o un menú contextual, según la configuración) |
| `Ctrl+Shift+F` | Buscar (`Enter` siguiente, `Shift+Enter` anterior, `Esc` cerrar) |
| `Ctrl+↑` / `Ctrl+↓` | Bloque de comando anterior / siguiente (sin bloques, llega al programa) |
| Clic en la marca de un bloque | Copiar comando / salida / ambos, volver a ejecutar |
| `Shift+Enter` | Salto de línea en agentes de IA; Shift+Enter nativo en el resto (PowerShell: AddLine) |
| `Ctrl+=` / `Ctrl+-` / `Ctrl+0` | Zoom de fuente |
| `Ctrl+clic` en un link | Abrir en el navegador |

Todos los atajos se escuchan en fase de captura sobre `window` (`lib/appShortcuts.ts`): ganan
sobre xterm y el programa nunca recibe una tecla que la app tomó. Por eso siguen el estilo de Windows Terminal (`Ctrl+Shift+…`,
`Alt+Shift+…`): `Ctrl+T` y `Ctrl+W` llegan al programa (readline, nano; verificado en e2e). Siguen
tomados por la app: `F2`, `Ctrl+1..9`, `Ctrl+Tab`, `Alt+flechas`, `Ctrl+B` (como en VS Code;
readline pierde su "carácter atrás", que tiene la flecha, y tmux su prefijo por defecto) y
`Ctrl+,` (como en VS Code y Windows Terminal).
Mantener apretado un atajo no repite la acción (`event.repeat` se ignora salvo para moverse
entre tabs y paneles), y la tecla igual no llega al programa.

## Gotchas conocidos

- **ConPTY pide la posición del cursor al arrancar** (`ESC[6n`, por `PSEUDOCONSOLE_INHERIT_CURSOR`)
  y no dibuja nada hasta recibir respuesta. xterm responde vía `onData`, que puede dispararse antes
  de que `create_session` devuelva el id: `TerminalSession` encola ese input y lo envía apenas
  conoce el id. Los tests de Rust responden a mano.
- `Ctrl+V` en xterm envía `^V` por defecto: el despacho de atajos frena la propagación (xterm no
  la ve) sin `preventDefault`, así el navegador dispara el evento `paste` nativo, que xterm sí
  maneja (incluye bracketed paste).
- **"Ignorar Ctrl+C" se hereda.** Si quien lanzó la app tenía `SetConsoleCtrlHandler(NULL, TRUE)`
  (o fue creado con `CREATE_NEW_PROCESS_GROUP`, como hacen muchas herramientas y launchers), todas
  las shells heredaban el flag y `^C` no interrumpía nada. `session.rs` lo limpia antes de cada
  spawn. Verificado: sin ese fix, 0/3 variantes interrumpían `ping -t`; con el fix, 3/3.
- Si la app se lanza desde dentro de Claude Code, hereda `CLAUDECODE` y otras variables de sesión.
  Desde la 7B la app las quita al lanzar shells y `claude -p` (`pty/nested.rs`; la e2e lanza la app
  con `CLAUDECODE=1` a propósito para probarlo); antes, `claude` se negaba a arrancar en sus
  terminales. Si Claude Code agrega variables nuevas de ese tipo, sumarlas a la lista.
- **`Ctrl+Shift+I` y DevTools**: en builds de desarrollo es también el atajo de DevTools de
  WebView2. El despacho de atajos lo toma en captura con `preventDefault` y DevTools no se abre
  (verificado en la e2e contando los targets `devtools://` por CDP).
- **Versiones Tauri alineadas**: el crate `tauri` y `@tauri-apps/api` deben coincidir en
  major.minor (lo mismo `tauri-plugin-opener` con `@tauri-apps/plugin-opener`). Con edition 2024
  el resolver respeta `rust-version`: si se baja, cargo elige versiones viejas de Tauri en
  silencio y `tauri dev` lo reporta como error. Hoy `rust-version = "1.90"` (lo que pide tauri 2.12).
- **xterm 6**: las decoraciones del search addon requieren `allowProposedApi: true`. El
  `.xterm-viewport` legado conserva `#000` y `overflow-y: scroll` de `xterm.css`; por eso el margen
  se da con `inset` en `.terminal-pane` (no con padding en `.xterm`) y el viewport es transparente
  y sin scrollbar nativa (ver `styles.css`).
- vim/nano de Git for Windows no están en el `PATH` de PowerShell: usar la ruta completa. El nano
  de MSYS2 se confunde con rutas Windows absolutas al guardar ("Save under DIFFERENT NAME?");
  abrirlo con rutas relativas.
- El portapapeles de Windows tiene un lock global: si otro proceso lo retiene, copiar/pegar puede
  fallar en silencio (visto 1 vez en 24 ciclos durante las pruebas). Si aparece en uso real, mover
  el portapapeles a un comando Rust con reintentos. En la Fase 4 otro programa lo tuvo abierto
  varios minutos seguidos (`OpenClipboard` → error 5 en cada intento, sin ventana dueña): las
  etapas `clipboard` y `agent` (pegado) fallan mientras dure. Diagnóstico rápido antes de culpar
  a la app: `OpenClipboard(NULL)` desde PowerShell (Add-Type) y mirar `GetLastError`.
- `onBinary` de xterm (reportes de mouse X10 no UTF-8) no se reenvía todavía.
- **@dnd-kit y `aria-disabled`**: `useSortable({ disabled })` marca la tab y todo su contenido como
  `aria-disabled` (lectores de pantalla, y Playwright no deja escribir en el input). Mientras se
  renombra, en vez de deshabilitar, simplemente no se enganchan los `listeners`.
- **Foco al cambiar de panel o tab (teclas en el panel equivocado)**: hasta que el foco se
  mueve, las teclas siguen yendo a la terminal que lo tenía, aunque ya esté oculta. Cuando
  `focusActiveTerminal()` esperaba al siguiente frame, lo tipeado justo después de `Alt+→`,
  `Ctrl+Tab` o un clic llegaba al panel anterior (el estrés de la etapa `typing` lo mostró: 1 y
  2 caracteres de un panel en otro). Ahora enfoca en el acto si el panel ya se ve, o en una
  microtarea, que corre después de que React aplica el cambio (React encola la suya al cambiar
  el store) y antes de cualquier tecla nueva; un frame después solo como último recurso. No
  roba el foco si hay un renombrado, menú, diálogo o edición en el explorador abiertos. Además,
  si la terminal activa pierde el foco hacia la nada (`<body>`), lo recupera en una microtarea:
  una tecla sin destino se pierde.
- **ConPTY pide reportes de foco** (DECSET 1004): xterm manda `ESC[I` / `ESC[O` al ganar o
  perder el foco y ConPTY los consume (no llegan al programa). En un volcado de lo que emite
  xterm, su presencia en medio de lo tipeado indica que el foco se fue.
- **Límite de contextos WebGL**: Chromium mantiene unos 16 contextos WebGL por página. Resuelto con
  WebGL solo en lo visible + `loseContext()` explícito al ocultar (ver "Tabs, grupos y panes").
- **Eventos de foco con la ventana sin foco**: Chromium no dispara `focus` mientras la ventana no
  tiene el foco del sistema. Por eso un clic en un panel lo selecciona en `pointerdown`, no solo en
  el `focus` del textarea. En el e2e, `Emulation.setFocusEmulationEnabled` hace que la página se
  comporte como enfocada aunque el usuario esté usando otras ventanas mientras corre la suite.
- **Arrastres en el e2e**: la barra de tabs anima después de cada reorden; `drag()` mide las
  posiciones recién cuando se estabilizan (`settledBox`), si no suelta donde la tab estaba antes.
- **Rutas `\\?\` y execution policy**: Tauri resuelve los recursos como `\\?\C:\...`; PowerShell
  trata esa ruta como de red y `RemoteSigned` rechazaba el script ("is not digitally signed"),
  así que la integración nunca cargaba en la app (en los tests de Rust, con ruta normal, sí).
  `launch` quita el prefijo (test `the_injected_script_path_is_never_verbatim`). Por el mismo
  motivo, un zip descargado y extraído con el Explorador (Mark of the Web) haría que
  `RemoteSigned` lo rechace; un instalador no marca los archivos. Si aparece el aviso:
  `Unblock-File` sobre el script.
- **E2E con prompts personalizados y Git Bash**: `runIdle()` no mira el texto del prompt sino el
  estado de la integración (shell libre, ningún comando corriendo). Espera la marca `133;D` del
  comando y después el prompt: tras redefinir `prompt`, ese primer prompt sale sin A/B (lo dibuja
  la función nueva, sin envolver) y el re-envoltorio recién cierra el comando desde
  `PSConsoleHostReadLine`.
- **Cuelgue de salida observado una vez (dev)**: tras una sesión larga de `tauri dev` con muchos
  HMR y recargas, cerrar la ventana dejó `terminal.exe` vivo sin ventanas, sin WebView2, sin hijos
  (el Job Object había limpiado todas las shells) y sin CPU. No se reprodujo en 3 intentos
  dirigidos (con y sin HMR), ni en corridas completas del e2e ni en release. Si reaparece: crear un
  dump (Administrador de tareas → "Crear archivo de volcado") antes de matarlo, para ver dónde está
  el hilo principal.
- **Transparencia de la ventana**: en Windows, tao la arma al crear la ventana
  (`DwmEnableBlurBehindWindow` + una superficie `softbuffer` que pinta el fondo, ~7 MB a
  1672×1106); no se puede activar después. WebView2 solo admite fondo totalmente transparente u
  opaco (alfa 0 o 255): la opacidad intermedia la pinta el HTML. Mica/Acrylic los dibuja DWM
  (`DWMWA_SYSTEMBACKDROP_TYPE`), así que una captura de la página por CDP no los muestra; para
  verificarlos sin tocar la pantalla del usuario se consulta ese atributo con
  `DwmGetWindowAttribute` (2 = Mica, 3 = Acrylic). Windows no deja que otro proceso traiga la
  ventana al frente para una captura de pantalla (sale lo que el usuario tenga encima).
- **jsonc-parser**: `modify` con valor `undefined` (borrar) lanza "Can not delete in empty
  document" si el padre de la ruta no existe; `editText` lo saltea. Pasó con la migración: el
  WebView2 de dev conserva el `localStorage` entre corridas (y entre la e2e y el uso a mano), así
  que la primera corrida tras la Fase 5 migró de verdad. `initSettings()` nunca rechaza: las
  terminales la esperan para arrancar.
- **jsonc-parser borra el comentario de arriba** al quitar una propiedad (el rango de la edición
  lo incluye). Por eso `editText` solo borra una sección que quedó vacía si en lo que se borra
  no hay `//` ni `/*` (test en `settingsSchema.test.ts`).
- **Dos escritores de settings.json**: `Ctrl+B` y "ver ocultos" guardan al instante. Una prueba
  que escribe el archivo justo después puede quedar debajo de la escritura de la app (que llegó
  después); `writeSettings()` de la e2e espera a que el texto de la app y el del disco coincidan
  antes de escribir.
- **Prompt largo después de un cambio de fuente/padding**: en la corrida completa, con la tab
  restaurada en la carpeta larga de la prueba, `run()` una vez no vio el prompt de PowerShell a
  tiempo tras cambiar fuente y padding (ConPTY redibuja al cambiar el tamaño). Sola no se
  reprodujo; `run()` ahora muestra la línea del cursor si falla.
- **Portapapeles y saltos de línea**: `navigator.clipboard.writeText` en Windows guarda `\n`
  como CRLF; leído de vuelta trae `\r\n` (la e2e lo normaliza).
- **El margen de bloques se dibuja en el siguiente frame**: una prueba que mira `.block-gutter`
  justo después de un cambio (agente detectado, setting) tiene que esperar un frame.
- **`Process.MainWindowHandle` no es la ventana de la app**: sin la barra nativa, .NET puede
  elegir la ventana oculta de mensajes de tao ("Tao Thread Event Target"). `win.ps1` y
  `caption.ps1` buscan la ventana visible del proceso que contiene `WRY_WEBVIEW`.
- **PowerShell no es DPI aware**: a 150 %, `GetWindowRect` de una ventana per-monitor devuelve
  coordenadas virtualizadas (207 px se ven como 138). `caption.ps1` llama
  `SetProcessDpiAwarenessContext` antes de medir. (`win.ps1` no: sus tamaños de resize siguen
  como siempre.)
- **tao conserva `WS_CAPTION`** en una ventana sin decoraciones (por la sombra): para saber si la
  barra de Windows está, mirar dónde empieza el área cliente respecto del borde de la ventana.
- **Pruebas de la barra propia**: un doble clic sintético por CDP es poco confiable (el primer
  mousedown inicia el arrastre nativo, que mira el botón real del mouse); la e2e despacha el
  mousedown con `detail: 2` que escucha el script de Tauri. Un `WM_NCMOUSEMOVE` sintético no deja
  hover: `TrackMouseEvent` ve el cursor real en otro lado y manda `WM_NCMOUSELEAVE` en el acto; la
  e2e prueba el estado con "presionado". Los Snap Layouts los dibuja Windows: verificados por el
  hit-test (`HTMAXBUTTON`), lo visual queda en el smoke manual.
- **Un toast tapa la terminal**: la "marca del bloque que no aparece bajo el mouse" (vista en la
  7A y otra vez en la 7B) era un toast de la etapa anterior (`layouts`, `session`) justo bajo el
  puntero: el panel recibía `mouseleave` con `relatedTarget = toast`. `freshTab()` y la
  recuperación tras una falla descartan el toast. La etapa `blocks` guarda un registro de
  `mousemove`/`mouseleave` y redibujos del margen y lo imprime si la marca vuelve a faltar.
- **Escribir un `serde_json::Value` directo a un archivo** (`writeln!(file, "{value}")`) lo
  escribe token por token (cada `write_str` es una escritura sin buffer): el log de
  notificaciones de la e2e podía leerse a medias. Se serializa a un `String` y se escribe de una.
- **Líneas largas en la e2e**: `textPosition` busca el texto en una fila; un comando largo puede
  partirse en el medio de una palabra según el ancho (`exit` en una fila, `4` en la siguiente).
  Anclar en una línea corta de la salida.

## Estado

- **Fase 1 — MVP: completa y verificada (2026-11-18).** Una terminal PowerShell a pantalla
  completa, PtyManager con Channels y batching, resize, ciclo de vida sin zombies, copiar/pegar,
  búsqueda, links, zoom.
  - `cargo test`: 6 unitarios + 8 de integración (ConPTY real: colores/truecolor, Ctrl+C, resize,
    código de salida, kill del árbol con nieto oculto, cierre por dueño), estables en 6 corridas.
  - `npm run e2e`: 34/34 (renderer WebGL, tamaños PTY = xterm al arrancar, con zoom y al
    redimensionar la ventana; colores por atributo de celda; Ctrl+C; copiar/pegar con
    Ctrl+C/Ctrl+V/Shift+Insert/clic derecho; búsqueda; vim; nano; agente falso con pegado
    multilínea; recarga de página; exit/restart; cerrar la ventana mata app + shell + nieto).
  - Release con CSP de producción: IPC, Ctrl+C y pegado OK, consola sin violaciones de CSP.
  - Medido en release (arranque limpio, 8 s en reposo): `terminal.exe` 6.4 MB en disco y 5.9 MB de
    memoria privada; app + WebView2 ≈ 216 MB privados, de los cuales **126 MB son el proceso GPU**
    de WebView2 (renderer 42 MB, browser 35 MB). La shell (powershell + conhost) suma ~60 MB aparte.
- **Pre-Fase 2: completa y verificada (2026-11-18).** Repo en GitHub (`origin/main`), README,
  `npm run e2e` en el repo, cierre selectivo de procesos (apps con ventana sobreviven), Shift+Enter
  por contexto y regla de agentes falsos en las pruebas.
  - `cargo test`: 17 unitarios + 12 de integración (incluye: `charmap` visible sobrevive y el
    oculto, la shell y un `ping` en consola oculta mueren; AddLine en PowerShell; cada agente falso
    recibe su salto de línea; un TUI que no es agente recibe Shift+Enter nativo), estables en 6 corridas.
  - `npm run e2e`: 39/39 (suma Shift+Enter con la tecla real en PowerShell y en los agentes
    falsos Claude y Gemini, y al cerrar la ventana: app con ventana sobrevive, GUI oculto muere).
- **Fase 2 — tabs y grupos: completa y verificada (2026-11-18).** Barra de tabs con atajos,
  renombrar (doble clic/F2) con título OSC automático, reordenar con @dnd-kit, menú contextual,
  grupos estilo Chrome (nombre, color, colapsar, arrastrar dentro/fuera), indicadores de actividad
  y de proceso terminado, terminales siempre montadas con `fit()` al mostrarse, confirmación al
  cerrar tabs con procesos, `.gitattributes` (LF).
  - `npm test`: 18 tests del modelo (reglas de arrastre y grupos, contigüidad, colapsar con la tab
    activa adentro, a qué tab se pasa al cerrar, navegación, títulos, indicadores).
  - `cargo test`: 17 unitarios + 13 de integración (suma `session_busy`: shell ociosa → nada,
    `ping` → listado, app con ventana → no cuenta).
  - `npm run e2e`: etapas `tabs`, `tabmenu` y `groups` (38 checks) sobre la app real, con mouse y
    teclado reales vía CDP: incluye que volver a una tab conserva la misma instancia xterm y su
    scrollback, que una tab oculta se re-ajusta al mostrarse tras un resize, que cerrar una tab con
    un proceso pide confirmación y que una app con ventana sobrevive al cerrar su tab.
- **Fase 3 — paneles divididos: completa y verificada (2026-11-18).** Árbol de splits anidables
  por tab (cada panel su propia sesión PTY), `Alt+Shift+D` / `Alt+Shift+-` y menú del panel,
  divisores arrastrables con doble clic para igualar, foco con borde, `Alt+flechas` y clic, cierre
  con herencia de espacio y confirmación, zoom `Ctrl+Shift+Z`, actividad y título por panel.
  Además: atajos estilo Windows Terminal (`Ctrl+T`/`Ctrl+W` vuelven al programa) y WebGL solo
  para terminales visibles.
  - `npm test`: 30 tests del modelo (12 nuevos de paneles: anidar/aplanar, herencia de espacio,
    geometría y divisores, navegación por posición, zoom, actividad entre paneles, `movePane`).
  - `npm run e2e`: 106/106. Nuevas etapas `panes` (26 checks: la instancia xterm original
    sobrevive a dividir, arrastrar, hacer zoom y cerrar; el PTY de cada panel coincide con su
    tamaño tras cada cambio), `passthrough` (`Ctrl+T`/`Ctrl+W` llegan como 0x14/0x17) y `gpu`
    (18 terminales: solo las 2 visibles tienen WebGL, sin avisos de Chromium).
- **Fase 4 — shell integration: completa y verificada (2026-11-18).** Scripts para PowerShell y
  Git Bash inyectados sin tocar el perfil (OSC 7 / 133 / 633), estado por panel (cwd, último
  comando, exit code, comando en ejecución), status bar, subtítulo de tab con la carpeta, dividir /
  duplicar / nueva tab en el mismo cwd con fallback a home, confirmación de cierre con OSC 133,
  selector de shell (▾) y aviso discreto si la integración no carga.
  - `npm test`: 41 (35 del modelo, 5 nuevos: marcas, carpeta durante un comando, fallos de carga,
    reinicio, herencia; 6 de parsers OSC y rutas).
  - `cargo test`: 22 unitarios + 16 de integración (PowerShell real: OSC 7 con espacios/tildes/ñ,
    E/C/D con códigos 0/7/1, prompt redefinido, `$?` hacia el prompt y hacia
    `PSConsoleHostReadLine`; policy `Restricted` → `IntegrationError` y la shell sigue; Git Bash
    con un `.bash_profile` propio que sigue cargando).
  - `npm run e2e`: 153/153 en dos corridas completas, la última con el código final. Las demás
    corridas del día fallaron por causas externas (otro programa retuvo el portapapeles; la
    ventana cambió de tamaño/monitor durante la corrida) o por el caso no reproducido de abajo.
    Etapas nuevas `cwd`, `commands`, `prompt`,
    `inherit`, `notice`, `gitbash` (incluye: URI de OSC 7 exacta, status bar ancha y angosta,
    `$LASTEXITCODE` intacto, `Start-Sleep` sin procesos hijos pide confirmación, historial y Tab
    de PSReadLine con un prompt propio, carpeta borrada → home).
  - Bug encontrado por la e2e: rutas `\\?\` de Tauri hacían que `RemoteSigned` rechazara el
    script (ver Gotchas). Release (`--no-bundle`): los scripts quedan junto al exe y la
    integración carga (verificado por CDP leyendo la status bar).
  - Visto una sola vez en ~8 corridas de `inherit` (completas y aisladas): tras duplicar por menú
    y `Ctrl+Shift+T` había una tab de más y el foco en `BODY`; en otra corrida, el clic en
    "Duplicar" no creó la tab. No se reprodujo. `openTab()` ahora exige exactamente una tab nueva
    y el paso de duplicar guarda captura + estado si falla, para tener evidencia la próxima vez.
  - **No verificado**: pwsh 7 (no está instalado acá; descargar el zip portable para probar fue
    bloqueado), oh-my-posh y starship reales. Lo de PSReadLine 2.2 está cubierto con una función
    equivalente en `tests/pty.rs`. Para verificarlo: instalar pwsh 7 (`cargo test` y la app lo
    eligen solos) y correr `cargo test` + `npm run e2e`.
- **Fase 5 — explorador de archivos: completa y verificada (2026-11-19).** Barra lateral
  (`Ctrl+B`, ancho y visibilidad recordados) que sigue el cwd del panel activo, con fijar y
  breadcrumbs; árbol perezoso y virtualizado; watcher de lo visible con debounce; `.gitignore` y
  carpetas ocultas por defecto con toggle; `cd` por clic solo con la shell libre (OSC 133) y el
  prompt vacío; insertar rutas con comillas por shell (clic, arrastre interno y desde el
  Explorador de Windows, en el panel donde se suelta); menú contextual completo; rama y colores de
  git en segundo plano. Antes: los atajos de acciones ignoran `keydown` con `repeat`.
  - `npm test`: 47 (6 nuevos del explorador: rutas, breadcrumbs, comillas PowerShell/Git Bash,
    árbol con ocultos heredados y 20 000 entradas, decoraciones de git).
  - `cargo test`: 28 unitarios (validación de nombres, crear/renombrar, porcelain v2, orden
    natural, watcher con ráfagas y liberación) + 3 de integración del explorador (listado con
    `.gitignore`/ocultos/atributo oculto, 5000 archivos en < 2 s, git real con rama y cambios) +
    16 de PTY.
  - `npm run e2e`: 213/213 con el código final. La corrida siguiente dio 209/213 por dos fallas ya conocidas del entorno de prueba, ajenas al explorador: el arrastre de una tab al chip de grupo (visto en la Fase 4) y el cierre de la ventana por PID con `win.ps1` cuando la ventana queda en otro tamaño o monitor (capturas a 1629×995 en vez de 1650×1050, igual que en la Fase 4). Etapas nuevas `explorer`, `explorercd`, `watcher`,
    `gitexplorer`, `bigfolder`, `explorermenu` (60 checks): mantener `Ctrl+Shift+T`/`Ctrl+B`
    apretado actúa una vez; ancho persistido tras recargar; seguir cwd al cambiar de panel y
    tab; fijar; carga perezosa; `cd` bloqueado con texto en el prompt y con `Start-Sleep`
    corriendo (no se escribe nada, "Abrir tab aquí" funciona); rutas con espacios, tildes y ñ;
    arrastre a un panel que no es el activo; drop nativo (`tauri://drag-drop` emitido por la
    prueba); Git Bash con ruta MSYS; watcher (crear/renombrar/borrar, subcarpeta, liberar al
    colapsar y al ocultar, ráfaga de 200); git (colores, `.gitignore`, rama, refresco tras
    `git add`/`checkout`); 5000 archivos (~40 filas en el DOM, sin tareas largas); menú
    (copiar rutas, crear, renombrar, papelera verificada y limpiada, tab y split aquí).
  - **RAM del explorador, release** (`terminal.exe` + WebView2, MB privados, GC forzado):
    visible en home vs oculto: sin diferencia medible (heap JS 7.0 vs 7.2, ruido). Con 5000
    archivos en pantalla: heap JS +4.7 (11.7), renderer +15 (58.7); al ocultarlo el heap vuelve
    a 8.7 (Chromium devuelve el resto al SO de a poco). Proceso Rust: 6.5 → 6.6. El proceso GPU
    oscila 134–165 sin relación con el explorador. Binario: 6.8 → 8.6 MB (`ignore` trae
    `regex`/`globset`; `notify` es chico).
  - Bugs encontrados por la e2e: un archivo creado entre el primer listado y el registro del
    watcher se perdía (ahora se re-lista al empezar a vigilar). En la prueba: "shell libre"
    exige ver el primer prompt (la marca de integración llega antes, a veces en otro lote).
  - Sin explicar todavía (vistos en 2 de ~7 corridas completas, nunca en las parciales ni en las
    dos últimas completas): (a) dos caracteres seguidos perdidos al tipear rápido (en `tabs`,
    justo después de que el agente falso sale con Ctrl+C, y en `explorercd`): el comando queda
    incompleto (`>>`) y la etapa espera de más; (b) dos veces, la página se cerró a mitad de una
    corrida con la app viva (después de cerrar tabs con `freshTab`). La primera coincidió con el
    límite de 600 s de la herramienta que corría la e2e; la segunda fue en segundo plano, así
    que no está explicada. Quedó instrumentado para la próxima: el log de `tauri dev` registra
    cargas de página y `CloseRequested`/`Destroyed`/`Exit` (solo debug), `TerminalSession` avisa
    por consola si una escritura a la sesión falla (antes se descartaba en silencio) y la e2e
    imprime los últimos mensajes de consola si la página se cierra. (a) quedó explicado en la
    estabilización de abajo: teclas que iban al panel anterior por un foco que llegaba tarde.
- **Estabilización de la entrada (2026-11-19).** Causa encontrada de las teclas "perdidas": el
  foco se movía un frame después de cambiar de panel o tab, y lo tipeado en ese hueco iba al
  panel anterior (con la prueba vieja, que tipea en una sola terminal, se veía como 1–2
  caracteres de menos). Corregido (ver Gotchas). Además, la entrada pasa por una cola ordenada
  con reintentos (`InputQueue`): antes cada tecla era un `invoke` independiente, sin orden
  garantizado y con los errores descartados; y el foco que cae a `<body>` se recupera solo.
  - El backend no pierde nada: test `every_keystroke_reaches_the_program_byte_for_byte` (5000
    escrituras de un carácter, ASCII, comillas, `\`, tildes, ñ, €, hacia `e2e/sink.mjs` en modo
    raw), 6/6 corridas iguales byte a byte.
  - E2E `typing`: tres terminales con `sink.mjs`, tramos al azar (semilla fija) con cambios de
    panel, tab, clic y `Ctrl+B` en el medio **sin esperar**; compara por panel lo que emitió
    xterm y lo que recibió el programa. Antes del arreglo falló en la primera corrida (3
    caracteres en el panel equivocado); después, ~71 000 teclas en 13 corridas: 1 falla, al
    principio (62 caracteres que no llegaron a ninguna xterm, en medio de un tramo, sin acción
    de la prueba cerca), no reproducida en 7 corridas pesadas más con contadores pasivos. Si
    vuelve, la prueba imprime el flujo crudo de xterm en el punto (con `ESC[O`/`ESC[I` si el foco
    se fue) y cuántas teclas recibió cada textarea.
  - `npm test`: 53 (6 de `InputQueue`: orden, un envío en vuelo, fusión, reintentos sin perder,
    Shift+Enter en su lugar, sesión terminada).
  - E2E dividida: `npm run e2e:smoke` (< 2 min) y `npm run e2e` (completa). `npm run e2e:smoke`: 80/80 en 82 s; `npm run e2e`: 214/214 en 321 s con el
    código final (antes de este arreglo la completa tardaba ~11 min: esperas de foco).
  - Ventana que se cierra a mitad de corrida: no se encontró la causa; queda el registro de la
    Fase 5 (log de ciclo de vida en `tauri dev`, consola al cerrarse la página).
- **Fase 6A — configuración, temas y perfiles: completa y verificada (2026-11-19).**
  `settings.json` (JSONC) con esquema tipado en TS, validación (un error deja la última
  configuración válida y avisa en la barra de estado), JSON Schema al lado para VS Code, cambios
  en vivo y escritura que conserva los comentarios del usuario; migración de `localStorage`.
  Pantalla `Ctrl+,` con Apariencia, Temas, Perfiles, Terminal y Explorador, y "Abrir
  settings.json en VS Code". Apariencia: fuente, tamaño, line-height, ligaduras, cursor, padding,
  scrollback, copiar al seleccionar, opacidad y Mica/Acrylic. Temas: Oscuro, Claro, Catppuccin
  (Mocha y Latte), Dracula, Tokyo Night y One Dark; importar JSON o esquemas de Windows Terminal;
  pintan la terminal y toda la UI (todo `styles.css` pasó a variables). Perfiles: pwsh (si
  existe), Windows PowerShell, cmd (cwd por OSC 9;9), Git Bash y cada distro WSL (registro), más
  los propios, con nombre, ícono, comando, args, cwd, env y tema; perfil por defecto; "▾" los
  lista. Comportamiento configurable: clic derecho (copiar/pegar o menú), explorador al
  arrancar, clic en carpeta (cd o navegar).
  - `npm test`: 75 (22 nuevos: esquema y validación, JSONC con comentarios y ediciones que
    conservan el formato, temas incluidos / import de Windows Terminal / derivación de UI,
    resolución de perfiles, comillas para cmd/WSL, OSC 9;9, ligaduras).
  - `cargo test`: 45 unitarios (perfiles y lanzamiento por tipo, args de PowerShell que permiten
    o no la integración, `%VARIABLES%`, lanzador de WSL ejecutado con el `sh` de Git, distros,
    JSONC mínimo, escritura atómica) + 3 de explorador + 21 de PTY (nuevos: cmd informa su
    carpeta a través de ConPTY, variables de un perfil, `-NoProfile` con integración, rama WSL
    de `bash.sh`).
  - `npm run e2e:smoke`: 90/90 en 66 s (suma la etapa `settings`). `npm run e2e`: 252/252
    en 336 s y, con el arreglo de `atShellPrompt` de abajo, 252/252 en 184 s; nuevas etapas `settings`, `themes`, `profiles`, `behavior` (38 checks): en vivo,
    JSON roto y tipo inválido con aviso, UI que conserva comentarios, Esc devuelve el foco, temas
    en terminal + UI, import de Windows Terminal, tema inválido explicado, tema por perfil, cmd
    con su cwd y sin `cd` desde el explorador, perfil propio con `-NoProfile`/env/cwd, oculto,
    por defecto desde la UI, menú contextual con Pegar, copiar al seleccionar, "solo navegar",
    explorador al arrancar oculto/visible, migración de `localStorage`, ligaduras, padding con
    PTY correcto, Mica con ventana opaca → "al reiniciar". Además `atShellPrompt` ahora mira la
    línea lógica: un prompt largo envuelto en un panel angosto hacía esperar 20 s de más
    (`inherit` 45 → 7 s, `explorer` 29 → 10 s). `E2E_TIMES=1` imprime la hora de cada check.
  - Una vez (smoke, no reproducido en `panes` sola ni en la completa): "arrastrar el divisor
    cambia los tamaños" con el divisor movido solo ~2 %, como si el arrastre se cortara tras el
    primer paso. Si vuelve, mirar si se pierde el pointer capture del divisor.
  - **Mica/Acrylic en release** (ventana creada transparente; verificado consultando a DWM, sin
    captura de pantalla): Mica → `DWMWA_SYSTEMBACKDROP_TYPE` 2, Acrylic → 3, y cambiar el efecto
    o la opacidad en `settings.json` se aplica en vivo (2 → 3 → 1 al quitarlo). **Costo**, release,
    14 s en reposo: opaca 218 MB (app 6.2, renderer 43.9, GPU 109.4, browser 36.6, otros 22.1) y
    0,06 s de CPU en 5 s; Mica 230 MB (app 13.1: la superficie `softbuffer` de tao; GPU +6) y
    0,13 s; Acrylic 85 % 232 MB y 0,13 s. La ventana opaca (el default) no paga nada.
    **No verificado a ojo** (la prueba no puede traer la ventana al frente sin molestar al
    usuario): queda en el smoke manual.
  - Binario release 8,6 → 8,9 MB (`serde_json` y el registro de WSL); JS 904 KB.
  - **No verificado**: pwsh 7 y WSL reales (no están instalados acá); ligaduras a ojo con
    Cascadia Code (la e2e verifica que el joiner se registre).
- **Fase 6B — atajos, paleta, sesión y layouts; la app pasa a llamarse Brisa: completa y
  verificada (2026-11-19).** Renombre (nombre visible, título, `brisa.exe`, `dev.brisa.desktop`,
  `BRISA_CONFIG_DIR`) con migración automática de `%APPDATA%\dev.terminal.desktop`. Atajos
  configurables en `keybindings` y en Configuración → Atajos (agregar grabando la tecla, quitar,
  varios por acción, reasignar, restaurar), con conflictos entre acciones, con teclas que
  bloquean la escritura y con las que usan los programas; un solo despacho en captura para todos
  los atajos (también los que antes manejaba xterm). Paleta `Ctrl+Shift+P` con búsqueda difusa,
  atajos, recientes primero y acciones dinámicas (tabs, paneles, perfiles, temas, layouts).
  Sesión restaurada al abrir (tabs, grupos, nombres, colores, layout con tamaños, perfil y carpeta
  de cada panel), guardada con escritura atómica, desactivable. Layouts de una tab o de la
  ventana en `layouts.json` (editable a mano, en vivo), con comandos iniciales que se escriben
  solo cuando OSC 133 dice que la shell está lista.
  - `npm test`: 92 (17 nuevos: atajos —parseo, eventos en teclados US/español/Dvorak/AltGr,
    resolución, conflictos, esquema, tecla grabada—, búsqueda difusa, formato de sesión y
    layouts —ida y vuelta, grupos por tramos, atajos de una tab, errores por layout, sesión
    rota—, secciones vacías que se borran sin perder comentarios).
  - `cargo test`: 47 unitarios (2 nuevos: la carpeta vieja se mueve; con la nueva existente se
    copia sin pisar) + 3 de explorador + 21 de PTY.
  - `npm run e2e`: 307/307 en 222 s con el código final (la corrida anterior, 302/305: ver abajo). Etapas nuevas `keybindings` (15 checks), `palette` (13),
    `session` (13), `layouts` (12) y `reopen` (2: cierra la ventana con la X, relanza `tauri dev`
    y comprueba lo restaurado). `npm run e2e:smoke` suma `keybindings` y `session`: 118/118 en 80 s.
  - **Release** (`--no-bundle`, CSP de producción, carpeta de config descartable): paleta,
    `session.json` guardado por IPC, `layouts.schema.json` escrito, sin errores de consola,
    cerrar y reabrir → vuelven las tabs (8/8, script por CDP). `brisa.exe` 8,9 MB (+3 KB); JS
    904 → 956 KB.
  - Sin dependencias nuevas.
  - Visto en una corrida completa (no en las parciales ni en la siguiente completa): los dos
    arrastres de `groups` (al chip y entre dos tabs del grupo) fallaron juntos, como en las Fases
    4 y 5; y `behavior` no vio el prompt a tiempo tras cambiar fuente y padding (ver Gotchas).
  - **No verificado**: la migración con la carpeta real del usuario (la e2e nunca la toca; está
    cubierta por los tests de Rust con carpetas temporales). Queda en el smoke manual. Los datos
    de WebView2 de `dev.terminal.desktop` (caché) no se migran ni se borran.
- **Fase 7A — bloques de comandos y soporte para agentes: completa y verificada (2026-11-19).**
  Todo local, sin red. Bloques sobre OSC 133 (marca roja si falló, menú al pasar el mouse:
  copiar comando / salida / ambos, volver a ejecutar; `Ctrl+↑` / `Ctrl+↓`; nada con vim/htop ni
  con agentes; API `paneBlocks` / `blockText` para la 7B y "Explicar / arreglar" preparado y
  oculto). Agentes (claude, codex, gemini): detección por procesos, estados trabajando /
  esperando / terminado (BEL, OSC 9, OSC 777 o silencio), indicador en la tab y el panel.
  Notificaciones nativas de Windows (toasts de WinRT) para paneles que no están a la vista, con
  clic que trae ese panel al frente. Preset multi-agente (2–4 paneles) con un git worktree por
  panel y limpieza al cerrar (solo los de Brisa; pregunta si hay cambios sin commitear). Todo
  desactivable (`blocks`, `agents`, `notifications`). Configuración de Claude Code documentada.
  - `npm test`: 95 (3 nuevos: OSC 9 / OSC 777 vs. comandos de ConEmu; prioridad de los
    indicadores de agente; la sesión recuerda los worktrees y los layouts nunca).
  - `cargo test`: 50 unitarios (codex nativo y por npm, escape del XML del toast, nombres de
    worktree) + 3 de explorador + 21 de PTY + 2 de worktrees con git real (crear junto al repo,
    cambios, rama que se conserva si tiene commits, uno ajeno nunca se toca, repo sin commits).
  - `npm run e2e`: 343/343 en 312 s. Etapas nuevas `blocks` (13 checks), `agents` (16) y
    `multiagent` (7), con el agente falso (claude/codex/gemini) y las notificaciones a un archivo.
    `npm run e2e:smoke` suma `blocks`: 131/131 en 105 s.
  - **Toast real**: verificado una vez desde la app de dev (Windows lo aceptó con el AUMID
    registrado: quedó en el historial del Centro de actividades) y borrado. **No verificado**:
    el clic real sobre el toast (la prueba no hace clic en la pantalla del usuario; el mismo
    camino se prueba con `debug_notification_click`): queda en el smoke manual.
  - **Release** (CSP de producción): paleta, sesión, marca roja de un bloque fallido, sin
    errores de consola, reabrir (9/9). `brisa.exe` 8,9 → 9,15 MB (WinRT de `windows`); JS
    956 → 981 KB.
  - Visto una vez (smoke, no repetido en 3 corridas siguientes): en `blocks`, la marca del bloque
    fallido no apareció bajo el mouse. Explicado en la 7B: un toast de la etapa anterior bajo el
    puntero (ver Gotchas).
  - **No verificado**: Claude Code, Codex y Gemini reales (regla de pruebas), ni qué secuencia
    manda cada canal de notificación de Claude Code; nombres reales del binario de Codex.
- **Fase 7B — capa de IA: completa y verificada (2026-11-20).** "Explicar / arreglar" en los
  bloques fallidos (comando, salida recortada, código, carpeta, shell y rama → respuesta en
  streaming en un panel lateral, con "Insertar" que escribe el comando sin ejecutarlo), lenguaje
  natural a comando (`Ctrl+I`, barra sobre el panel activo, para PowerShell / cmd / bash) y un
  chat corto por panel (`Ctrl+Shift+I`) con bloques agregados desde su menú. Dos proveedores:
  `claude -p` con la suscripción (sin herramientas, sin permisos, sin CLAUDE.md ni config del
  proyecto, en una carpeta vacía y un Job Object) y la API de Anthropic (WinHTTP, key en el
  Administrador de credenciales). Redacción de secretos obligatoria antes de enviar nada, "Ver qué
  se envía" (antes y después), aviso en comandos destructivos, cancelar con Esc o botón, y todo
  apagado con `ai.enabled: false` (también en el backend). Sin dependencias nuevas.
  - Flags de `claude -p` verificados en la documentación y contra `claude` 2.1.329 (`--help`,
    `auth status --json`, y el error sin sesión capturado con un `CLAUDE_CONFIG_DIR` vacío: sin
    credenciales no hay llamada a la API).
  - De paso: las shells ya no heredan `CLAUDECODE` y las demás variables de una sesión de Claude
    Code (solo la e2e las limpiaba); el botón "Explicar / arreglar" preparado en la 7A estaba
    encima de la fila y desaparecía al ir a buscarlo (ahora en la fila, con hover estable); el
    margen de bloques reemplazaba sus elementos en cada render de xterm (clics perdidos); el log
    de notificaciones de la e2e se escribía token por token.
  - `npm test`: 116 (21 nuevos: redacción —tokens de GitHub classic/OAuth/fine-grained, keys de
    Anthropic api03/oat01 y OpenAI proj/legacy, connection strings de SQL Server, Azure Storage,
    Service Bus, postgres y mongodb, JWT, AWS, Google, Stripe, Slack, npm, claves privadas,
    flags, .env, listados de entorno, entropía, y 15 salidas comunes que no se tocan—, seguridad
    —destructivos y no destructivos, inserción sin saltos de línea ni caracteres de control— y
    prompts —contexto, recorte, fences, historial, parseo de respuestas—).
  - `cargo test`: 66 unitarios (16 nuevos: stream-json con las líneas reales capturadas, SSE con
    cualquier troceo, errores de la API, flags de aislamiento, ruta configurada inexistente,
    modelos, cuerpo de la API, variables anidadas, secretos de entorno, cancelación) + 6 de
    `tests/ai.rs` (claude falso por `.cmd`: streaming, entorno limpio, carpeta propia, errores,
    cancelación que mata a node a través de `cmd.exe`; IA apagada; API falsa local con la key
    del Administrador de credenciales; sin servidor) + 3 explorador + 21 PTY + 2 worktrees.
  - `npm run e2e`: 379/379 en 293 s. Etapa nueva `ai` (36 checks). `npm run e2e:smoke` suma la
    parte esencial de `ai`: 144/144 en 97 s.
  - Corridas del día con fallas, todas explicadas y corregidas en la prueba o en la app: un toast
    bajo el puntero (la "marca que no aparece" de la 7A), marcas reemplazadas en cada render,
    una línea larga partida en el medio de `exit 4`, el log de notificaciones leído a medias, y
    una notificación legítima de una etapa anterior contada como nueva. Una vez cada una, sin
    repetirse: `cd en el panel activo: el explorador lo sigue` (etapa `explorer`) y la campana en
    un panel oculto de `agents`; en la misma máquina, con la ventana a veces tapada por otras
    (Chromium frena los frames).
  - **Release** (`--no-bundle`, CSP de producción, carpeta de config descartable con
    `ai.claudePath` apuntando al claude falso: en release `BRISA_CLAUDE_PATH` se ignora, y una
    ruta configurada nunca cae a otro claude): bloque fallido → "Explicar / arreglar" →
    respuesta en streaming en el panel, el falso corrió aislado, sin errores de consola (5/5,
    script por CDP). `brisa.exe` 9,15 → 9,40 MB (+250 KB; medido compilando también el commit
    de la 7A); JS 981 → 1030 KB (Vite avisa que el chunk pasa de 1 MB).
  - **No verificado**: `claude -p` real respondiendo (regla de pruebas: el stream con texto
    —`stream_event` / `text_delta`, `result`— sale de la documentación y del falso, no de una
    captura; el error sin sesión sí es real), la API real de Anthropic, versiones de `claude`
    anteriores a 2.1.329 (si no conocen `--safe-mode` o `--effort`, la app pide actualizar).
    Queda en el smoke manual, a criterio del usuario.
- **Pulido visual — diseño, barra de título y colores: completo y verificado (2026-11-20).**
  Tokens de diseño en un solo lugar (radios, espacios, bordes, sombras, hover) aplicados a toda la
  UI; `appearance.cornerRadius` (0–16, por defecto 8) en vivo, con paneles, explorador y panel de
  IA como tarjetas cuando es mayor que 0. Barra de título propia: las tabs junto a minimizar /
  maximizar / cerrar, arrastre y doble clic desde el espacio vacío, resize por arriba, Snap
  Layouts de Windows 11 (ventana hija nativa sobre los botones, como Windows Terminal) y
  `appearance.titleBar: "native"` en vivo. Colores: barra, explorador y terminal derivados del
  mismo tema con una jerarquía sutil (color `sidebar` nuevo; paletas oficiales de cada tema;
  nada de negro puro). Breadcrumbs que colapsan en "…" (primero y último siempre visibles).
  - De paso: la grilla de Configuración se desbordaba con una ruta larga en el pie (botones
    cortados); la línea de grupo de las tabs pisaba el subtítulo. `win.ps1` y `caption.ps1`
    encuentran la ventana de la app aunque `MainWindowHandle` apunte a la de mensajes de tao.
  - `npm test`: 118 (`fitCrumbs`; jerarquía chrome < sidebar < terminal en todos los temas).
  - `cargo test`: 69 unitarios (3 nuevos: botón bajo un punto, estado serializado,
    `appearance.titleBar`) + 6 de IA + 3 explorador + 21 PTY + 2 worktrees.
  - `npm run e2e`: 397/397 en 298 s. Etapa nueva `chrome` (18 checks: barra propia, hit-test
    8/9/20 de la ventana hija y su tamaño en px físicos, regiones de arrastre, presionado,
    maximizar/restaurar por botón y por doble clic, radios 8/0/12 en vivo en tabs, paneles,
    explorador y paleta, borde del panel de IA arrastrable en modo tarjetas, barra nativa en vivo
    y de vuelta, colores de los 7 temas, breadcrumbs con "…", y capturas de la página de Oscuro,
    Claro y Catppuccin con radio 0 y 8 en `e2e/artifacts/design-*.png`). `npm run e2e:smoke` suma
    la parte esencial de `chrome`: 154/154 en 101 s.
  - Revisado a ojo (capturas de la página por CDP, regla de capturas): radio 0 y 8 con Oscuro,
    Claro, Catppuccin Mocha y Latte, Dracula y One Dark; configuración, paleta y menús.
  - Encontrado por la e2e y corregido: en modo tarjetas el `overflow: hidden` de las tarjetas
    recortaba el borde de redimensionado del explorador y del panel de IA.
  - **Release** (CSP de producción, manifiesto embebido): la ventana hija se crea (layered en
    hija = Windows 8+ en el manifiesto), hit-test 8/9/20, maximizar/restaurar, tarjetas y colores,
    sin errores de consola (5/5). `brisa.exe` 9,40 → 9,43 MB (+31 KB); CSS 39,6 KB; JS 1030 →
    1037 KB.
  - **No verificado**: el flyout de Snap Layouts a la vista, el arrastre y el doble clic con el
    mouse real (los dibuja / maneja Windows; queda en el smoke manual); Windows 10 (sin esquinas
    redondeadas del sistema; el borde de 1 px de la sombra sin decoraciones).
- Siguiente candidata — **peso de WebView2**: medir WebGL vs DOM en memoria del proceso GPU,
  probar `--in-process-gpu` (`additionalBrowserArgs`) y `MemoryUsageTargetLevel = Low` al
  minimizar. Es lo que más mueve la aguja frente al objetivo "mucho más liviana que Warp".
- Próximas fases (ideas): navegación por teclado en el árbol del explorador, arrastrar paneles a otra tab o a una tab nueva (modelo listo: `movePane`),
  integración para zsh/fish en WSL, saltar entre comandos y seleccionar la salida de uno (marcas
  133 ya disponibles), notificaciones al terminar comandos largos (133;D), flow control con ACKs
  para salidas gigantes, `conpty.dll` + `OpenConsole.exe` empaquetados (ConPTY más nuevo que el
  del sistema), lista de agentes y sus secuencias configurable, imágenes como ícono de perfil.
