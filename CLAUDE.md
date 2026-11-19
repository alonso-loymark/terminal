# Terminal — guía del proyecto

Terminal de escritorio para Windows, liviana y muy personalizable, pensada para trabajar con
agentes de IA (Claude Code, Codex, Gemini CLI). Objetivo explícito: ser **mucho más liviana que
Warp** (binario chico, poca RAM, arranque rápido). Cada dependencia nueva tiene que justificarse.

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
- **Comandos Tauri**: `create_session` (devuelve `{ sessionId, shell, integration }`),
  `write_to_session`, `resize_session`, `close_session`, `send_shift_enter` (ver abajo),
  `session_busy`, `system_info` (`{ homeDir, shells }`, una vez al arrancar) y `pty_backend`
  (devuelve `{ backend: "conpty", buildNumber }` para la opción `windowsPty` de xterm, que con
  build ≥ 21376 activa el reflow compatible con ConPTY). Explorador (`explorer_commands.rs`):
  `list_dir`, `watch_start` / `watch_set` / `watch_stop`, `git_status`, `create_entry`,
  `rename_entry`, `trash_entries`, `open_in_vscode`, `open_in_file_manager`.
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
  (enviaría el prompt): por eso la decisión es por contexto. Codex no está en la tabla: usa
  crossterm, que lee eventos de teclado nativos, así que recibe el Shift+Enter nativo como en
  Windows Terminal (no verificado: no hay codex instalado y no se prueban agentes reales). El
  pedido viaja por la misma cola que las teclas (`InputQueue`), así no se reordena con ellas.
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
- **Frontend** (`lib/shellIntegration.ts`): `registerOscHandler` para 7, 133 y 633 → eventos
  puros → `applyShellEvent` en el modelo. Cada `Pane` guarda `cwd`, `lastCommand`,
  `lastExitCode`, `commandRunning`, `integration` (`pending`/`ok`/`unavailable`/`error`) y la
  shell. Un OSC 7 que llega **mientras corre un comando** se ignora (ssh a otra máquina, shells
  anidadas: no es la carpeta del panel).
- **cwd heredado**: dividir y duplicar usan la shell y la carpeta del panel; nueva tab, la carpeta
  del panel activo con la shell por defecto (`spawnOf`: `cwd` reportado, si no la carpeta de
  arranque). El reinicio tras `exit` arranca donde estaba. Si la carpeta ya no existe o no se
  puede listar, el backend usa la carpeta del usuario (`resolve_cwd`, y reintenta ahí si el
  spawn falla), sin mostrar error.
- **Status bar** (`StatusBar.tsx`): cwd del panel activo (home como `~`, segmentos del medio
  colapsados en `…` según el ancho; ruta completa en el tooltip), comando en ejecución o ✓/✗ con
  el código, aviso de integración y nombre de la shell. La tab muestra la carpeta como subtítulo
  si no fue renombrada.
- **Cerrar**: la confirmación incluye el comando en ejecución según OSC 133 además de los
  procesos de `session_busy`. Así también pregunta por trabajo sin procesos hijos
  (`Start-Sleep`, un script de PowerShell largo).
- **Selector de shell**: "▾" junto al "+" (solo si hay más de una shell). Hoy: PowerShell y
  Git Bash.
- **WSL (pendiente, cómo agregarlo)**:
  1. Perfil: `ShellKind::Wsl` en `shell.rs`, programa `%SystemRoot%\System32\wsl.exe`
     (detectarlo con `wsl.exe --list --quiet`; una entrada por distro si se quiere).
  2. cwd: `wsl.exe --cd <ruta Windows>` acepta rutas Windows y las traduce; no hace falta
     `CHERE_INVOKING`.
  3. Script: reutilizar `bash.sh` sin la emulación de login de Git Bash (WSL ya corre
     `~/.bashrc`). Inyectarlo con `wsl.exe -e bash --rcfile /mnt/c/.../bash.sh -i` (ruta del
     recurso traducida con `wslpath` o armada a mano: `C:\x` → `/mnt/c/x`), o con
     `--init-file`. Para zsh/fish, scripts propios (precmd/preexec en zsh).
  4. OSC 7: en WSL el `$PWD` es Linux. Emitir `file://wsl.localhost/<distro>/<ruta>` para rutas
     del distro y la ruta Windows (`/mnt/c/x` → `C:/x`) para las montadas, así `cwdFromFileUri`
     produce `\\wsl.localhost\<distro>\...` o `C:\...`, que sirven como cwd de un panel nuevo.
     Ojo: hoy un host distinto se interpreta como UNC (correcto para `wsl.localhost`).
  5. `resolve_cwd` acepta UNC `\\wsl.localhost\...` (es listable desde Windows) y Rust puede
     pasarlo a `wsl.exe --cd`.
  6. Tests: como `git_bash_integration_loads_the_users_profile_and_reports_commands`, con skip si
     no hay WSL.

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
- **Preferencias**: visible, ancho y "ver ocultos" en `localStorage` (`terminal.explorer`)
  hasta la Fase 6.
- **RAM** (números en "Estado"): el árbol cuesta poco porque solo se guarda lo visible; al
  colapsar u ocultar se descartan listados y watchers.

## Estructura

```
CLAUDE.md
index.html, vite.config.ts, tsconfig.json, package.json
src/                        Frontend (solo render + input)
  main.tsx, App.tsx (título de ventana = tab activa), styles.css
  components/TabBar.tsx     Barra de tabs + DndContext (TabItem, GroupChip, RenameInput)
  components/ContextMenus.tsx  Menús de tab y de grupo (primitivas en Menu.tsx)
  components/ConfirmDialog.tsx Confirmación al cerrar tabs con procesos
  components/Workspace.tsx  Todos los TerminalPane montados y posicionados + divisores + SearchBar
  components/TerminalPane.tsx  Una instancia xterm + addons + sesión por pane (memo, nunca se recrea)
  components/PaneDivider.tsx   Divisor arrastrable (doble clic: igualar)
  components/StatusBar.tsx  cwd del panel activo, rama de git, último comando, aviso de integración
  components/Sidebar.tsx    Explorador: breadcrumbs, fijar, ver ocultos, aviso, ancho redimensionable
  components/FileTree.tsx   Árbol virtualizado: clic (cd / insertar), arrastrar a un panel, renombrar
  lib/pty.ts                Punto de IPC de las terminales; wrappers tipados de los comandos
  lib/fsApi.ts              Punto de IPC del explorador (listar, watcher, git, operaciones, drop nativo)
  lib/explorerModel.ts      Lógica pura del explorador (+ explorerModel.test.ts)
  lib/explorerData.ts       Listados perezosos con generación, watcher de lo visible, refresco de git
  lib/explorerActions.ts    cd con guardas, insertar rutas, acciones del menú contextual
  lib/dropTarget.ts         Panel bajo el puntero, resaltado, archivos soltados desde otras apps
  lib/terminalSession.ts    Conecta un Terminal de xterm con una sesión PTY (entrada en cola, restart)
  lib/inputQueue.ts         Cola de entrada por sesión: orden, un envío a la vez, reintentos (+ test)
  lib/shellIntegration.ts   Handlers OSC 7/133/633 → ShellEvent (parsers puros + shellIntegration.test.ts)
  lib/paths.ts              Nombre de carpeta y acortado de rutas (~, …) para la UI
  lib/terminalRegistry.ts   PaneId → { term, fit, search, session } (objetos imperativos)
  lib/tabActions.ts         Cerrar con confirmación, cerrar ventana con la última tab, foco
  lib/appShortcuts.ts       Atajos de tabs/grupos (listener en captura sobre window)
  lib/keybindings.ts        Atajos de terminal: copiar/pegar, búsqueda, zoom, Shift+Enter
  lib/clipboard.ts          navigator.clipboard con fallback
  lib/renderer.ts           GpuRenderer: WebGL solo mientras se ve, fallback al DOM, loseContext al ocultar
  lib/paneGeometry.ts       Rectángulos del layout → CSS de panes y divisores (gap, mínimo en px)
  lib/devHooks.ts           Solo dev: window.__terminal / __workspace / __ui para e2e
  store/workspaceModel.ts   Modelo puro de tabs/grupos/panes (+ workspaceModel.test.ts)
  store/workspace.ts        zustand sobre el modelo (ids, acciones)
  store/ui.ts               zustand: renombrado, menú, diálogo, búsqueda (estado efímero)
  store/system.ts           zustand: carpeta del usuario y shells disponibles (system_info)
  store/explorer.ts         zustand: estado del explorador (persistencia simple en localStorage)
  store/git.ts              zustand: estado de git por repositorio + refreshGit (un proceso a la vez)
  store/settings.ts         zustand: fuente, cursor, scrollback, tema, zoom
  config/theme.ts, colors.ts  Tema y paleta de colores de tabs/grupos
src-tauri/
  src/lib.rs                Builder de Tauri, ciclo de vida de ventanas/página/app
  src/commands.rs           Comandos Tauri finos: validan y delegan en PtyManager
  src/explorer_commands.rs  Comandos del explorador (spawn_blocking) y su canal del watcher
  src/explorer/             list.rs, watch.rs, git.rs, ops.rs (sin Tauri; tests unitarios)
  src/pty/manager.rs        Registro de sesiones (create/write/resize/close/close_owned_by/shutdown)
  src/pty/session.rs        ConPTY + hilos reader/flusher/writer/waiter + batching
  src/pty/job.rs            Job Object: miembros, KILL_ON_JOB_CLOSE, kill verificado (solo Windows)
  src/pty/teardown.rs       Cierre selectivo: consola muere, apps con ventana sobreviven
  src/pty/agents.rs         Shift+Enter por contexto: detección de agentes de IA y secuencias
  src/pty/procs.rs          Tabla de procesos (Toolhelp), dueños de ventanas, command lines (Windows)
  src/pty/shell.rs          Perfiles (PowerShell: pwsh → powershell.exe; Git Bash), cómo lanzarlos
                            con la integración, cwd inicial y fallback a %USERPROFILE%
  src/pty/platform.rs       Build de Windows (RtlGetVersion) para `pty_backend`
  resources/shell-integration/  powershell.ps1 y bash.sh (recursos del bundle)
  tests/pty.rs              Tests de integración con procesos reales (PowerShell/Git Bash/ConPTY)
  tests/explorer.rs         Listado (.gitignore, ocultos, 5000 archivos) y git real
e2e/
  run.mjs                   E2E sobre la app real vía CDP de WebView2 (`npm run e2e`)
  fake-agent.mjs            Agente de IA falso para pruebas (ver "Pruebas con agentes")
  sink.mjs                  Programa en modo raw que guarda byte a byte lo que recibe (estrés de entrada)
  win.ps1                   Resize/cierre de la ventana de la app por PID (Win32)
  recycle.ps1               Verifica que lo borrado por la e2e está en la papelera y lo saca de ahí
  artifacts/                Capturas y log de `tauri dev` (ignorado por git)
```

## Comandos

```powershell
npm install
npm run tauri dev                       # app en modo desarrollo (Vite + cargo run)
npm run build                           # typecheck (tsc) + build del frontend
npm test                                # tests unitarios del frontend (node --test, sin dependencias)
npm run tauri build -- --no-bundle      # exe release en src-tauri/target/release/
cd src-tauri; cargo fmt --check; cargo clippy --all-targets -- -D warnings; cargo test
npm run e2e:smoke                       # lo esencial (~80 s): en cada cambio
npm run e2e                             # todas las etapas (~4,5 min): para cerrar una fase
npm run e2e -- tabs,groups              # solo algunas etapas
E2E_ATTACH=1 npm run e2e -- tabs        # contra una app ya abierta con CDP en el puerto 9223
```

Los tests unitarios de TypeScript (`*.test.ts`) corren con el type stripping nativo de Node 24:
solo sintaxis borrable (`erasableSyntaxOnly`), imports con extensión `.ts` y quedan fuera del
`tsconfig` de la app.

`npm run e2e` necesita los puertos 1420 (Vite) y 9223 (CDP) libres. Abre una ventana real de la
app, abre y cierra ventanas de `charmap.exe` (prueba de apps con ventana) y usa el portapapeles
(lo restaura al terminar). `cargo test` también abre `charmap` brevemente. Capturas en
`e2e/artifacts/`.

## Pruebas con agentes de IA (regla obligatoria)

- **Ninguna prueba (e2e, de integración ni manual automatizada) envía input a un `claude`,
  `codex` o `gemini` real**, ni siquiera tipear sin Enter: cualquier interacción puede consumir
  uso de la cuenta del usuario (y un agente en *auto mode* puede ejecutar cosas).
- Para probar comportamiento con agentes se usa `e2e/fake-agent.mjs`: editor de línea en raw
  mode, bracketed paste, la secuencia de salto de línea de cada agente y "Ctrl+C dos veces para
  salir". Se ejecuta con un `node.exe` enlazado como `claude.exe` / `gemini.exe`, así la
  detección de agentes de la terminal se prueba con el mismo nombre de imagen que el real.
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
Shift+Enter con agentes falsos, tabs, paneles, shell integration, estrés de entrada, explorador
y cierre; ~80 s, tiene que quedar por debajo de 2 min). La suite completa (`npm run e2e`,
~4,5 min) se corre para cerrar la fase. Mientras corre cualquiera de las dos, no tocar `src/`
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

## Atajos

| Atajo | Acción |
|---|---|
| `Ctrl+Shift+T` / botón `+` | Nueva tab (en la carpeta del panel activo) |
| Botón `▾` junto al `+` | Nueva tab con otra shell (Git Bash) |
| `Ctrl+B` | Mostrar / ocultar el explorador de archivos |
| Clic en carpeta / archivo del explorador | `cd` en el panel activo (si está libre) / insertar la ruta |
| Arrastrar del explorador (o del Explorador de Windows) a un panel | Pegar la ruta con comillas en ese panel |
| `F2` / `Supr` con el árbol enfocado | Renombrar / mover a la papelera |
| `Ctrl+Shift+W` | Cerrar el panel activo; si es el último, la tab (confirma si hay procesos además de la shell) |
| `Alt+Shift+D` / `Alt+Shift+-` | Dividir el panel a la derecha / hacia abajo |
| `Alt+←↑→↓` | Mover el foco al panel en esa dirección |
| `Ctrl+Shift+Z` | Maximizar / restaurar el panel activo dentro de la tab |
| Clic en un panel | Enfocarlo |
| Arrastrar un divisor / doble clic | Redimensionar / repartir en partes iguales |
| `Shift`+clic derecho en un panel, `Shift+F10` | Menú del panel: dividir, maximizar, igualar, cerrar |
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
| Clic derecho | Copia si hay selección; si no, pega |
| `Ctrl+Shift+F` | Buscar (`Enter` siguiente, `Shift+Enter` anterior, `Esc` cerrar) |
| `Shift+Enter` | Salto de línea en agentes de IA; Shift+Enter nativo en el resto (PowerShell: AddLine) |
| `Ctrl+=` / `Ctrl+-` / `Ctrl+0` | Zoom de fuente |
| `Ctrl+clic` en un link | Abrir en el navegador |

Los atajos de tabs y paneles se escuchan en fase de captura sobre `window`: ganan sobre xterm y el
programa nunca los recibe. Por eso siguen el estilo de Windows Terminal (`Ctrl+Shift+…`,
`Alt+Shift+…`): `Ctrl+T` y `Ctrl+W` llegan al programa (readline, nano; verificado en e2e). Siguen
tomados por la app: `F2`, `Ctrl+1..9`, `Ctrl+Tab`, `Alt+flechas` y `Ctrl+B` (como en VS Code;
readline pierde su "carácter atrás", que tiene la flecha, y tmux su prefijo por defecto).
Mantener apretado un atajo no repite la acción (`event.repeat` se ignora salvo para moverse
entre tabs y paneles), y la tecla igual no llega al programa.

## Gotchas conocidos

- **ConPTY pide la posición del cursor al arrancar** (`ESC[6n`, por `PSEUDOCONSOLE_INHERIT_CURSOR`)
  y no dibuja nada hasta recibir respuesta. xterm responde vía `onData`, que puede dispararse antes
  de que `create_session` devuelva el id: `TerminalSession` encola ese input y lo envía apenas
  conoce el id. Los tests de Rust responden a mano.
- `Ctrl+V` en xterm envía `^V` por defecto: el key handler devuelve `false` para dejar que el
  navegador dispare el evento `paste` nativo, que xterm sí maneja (incluye bracketed paste).
- **"Ignorar Ctrl+C" se hereda.** Si quien lanzó la app tenía `SetConsoleCtrlHandler(NULL, TRUE)`
  (o fue creado con `CREATE_NEW_PROCESS_GROUP`, como hacen muchas herramientas y launchers), todas
  las shells heredaban el flag y `^C` no interrumpía nada. `session.rs` lo limpia antes de cada
  spawn. Verificado: sin ese fix, 0/3 variantes interrumpían `ping -t`; con el fix, 3/3.
- Si la app se lanza desde dentro de Claude Code, hereda `CLAUDECODE` y otras variables de sesión,
  y `claude` se niega a arrancar anidado. Lanzar la app desde un entorno limpio.
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
- Siguiente candidata — **peso de WebView2**: medir WebGL vs DOM en memoria del proceso GPU,
  probar `--in-process-gpu` (`additionalBrowserArgs`) y `MemoryUsageTargetLevel = Low` al
  minimizar. Es lo que más mueve la aguja frente al objetivo "mucho más liviana que Warp".
- Próximas fases (ideas): Fase 6 (persistencia completa: tabs, grupos, cwd y las preferencias del
  explorador que hoy van en `localStorage`), navegación por teclado en el árbol del explorador,
  arrastrar paneles a otra tab o a una tab nueva (modelo listo: `movePane`), WSL (ver "Shell
  integration"), saltar entre comandos y seleccionar la salida de
  uno (marcas 133 ya disponibles), notificaciones al terminar comandos largos (133;D),
  persistir tabs/grupos (y su cwd) entre sesiones, archivo de configuración (fuente, tema, shell,
  atajos), perfiles de shell configurables, flow control con ACKs para salidas gigantes,
  `conpty.dll` + `OpenConsole.exe` empaquetados (ConPTY más nuevo que el del sistema), lista de
  agentes y sus secuencias configurable.
