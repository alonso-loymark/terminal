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

## Arquitectura

**Rust maneja los procesos; React solo renderiza y reenvía input.** Ninguna lógica de procesos
vive en el frontend.

```
 React / WebView2                                   Rust (proceso Tauri)
 ────────────────                                   ────────────────────
 TerminalSession ── invoke create_session ────────► commands.rs ─► PtyManager::create
   (lib/terminalSession.ts)  {cols, rows,                             │ abre ConPTY, lanza la shell,
                              onData: Channel,                        │ la mete en un Job Object
                              onExit: Channel}                        ▼
 xterm.onData ───── invoke write_to_session ──────► mpsc ──► hilo writer ──► stdin del PTY
 ResizeObserver+fit ─ invoke resize_session ──────► MasterPty::resize (ResizePseudoConsole)
 term.write(bytes) ◄─ Channel onData (bytes crudos) ◄─ hilo flusher ◄─ mpsc ◄─ hilo reader ◄─ salida PTY
                         (lotes de ≤5 ms / ≤256 KB)
 mensaje de salida ◄─ Channel onExit (JSON) ◄────── flusher, después del EOF ◄─ hilo waiter (child.wait)
```

Reglas de la arquitectura:

- **IPC por Tauri Channels por sesión, nunca eventos globales (`emit`/`listen`).** La salida viaja
  como bytes crudos (`InvokeResponseBody::Raw` → `ArrayBuffer`); Rust no decodifica UTF-8, xterm
  maneja las secuencias multibyte partidas entre lotes.
- **Batching**: el hilo flusher junta todo lo que llega en una ventana de 5 ms (o hasta 256 KB) y
  manda un solo mensaje. Constantes en `src-tauri/src/pty/session.rs`.
- **Hilos por sesión** (stack chico, nombrados `pty-<id>-*`): `reader` (lee el PTY), `flusher`
  (agrupa y envía), `writer` (escribe el input sin bloquear al IPC), `waiter` (espera al hijo).
- **Ciclo de vida / nada de zombies**:
  - Cada shell entra en un **Job Object con `KILL_ON_JOB_CLOSE`** (`pty/job.rs`): cerrar la sesión
    mata el árbol completo (incluye nietos con consola oculta, p. ej. servidores MCP de un agente),
    y si la app crashea el SO mata todo al cerrar el handle.
    Consecuencia buscada pero a tener en cuenta: una app GUI lanzada desde la terminal que no se
    "separe" del job (p. ej. `code .` sin otra instancia abierta) se cierra con la sesión. Los
    procesos que piden `CREATE_BREAKAWAY_FROM_JOB` sí pueden escapar.
  - Cuando el hijo termina solo, el waiter guarda el código de salida y desmonta la sesión. Esto
    cierra el pseudoconsole: **ConPTY no da EOF al reader mientras el HPCON siga abierto**.
  - El flusher manda `onExit` recién después del EOF, así el mensaje de salida nunca se adelanta
    a la última salida de la shell.
  - Las sesiones pertenecen a un webview (label). Cerrar la ventana (`WindowEvent::Destroyed`),
    recargar la página (`on_page_load` Started) o salir de la app (`RunEvent::Exit`) cierra las
    sesiones de ese dueño.
- **Ids de sesión**: `u32` incremental asignado por `PtyManager` (único dentro del proceso).
- **Comandos Tauri**: `create_session`, `write_to_session`, `resize_session`, `close_session` y
  `pty_backend` (devuelve `{ backend: "conpty", buildNumber }` para la opción `windowsPty` de
  xterm, que con build ≥ 21376 activa el reflow compatible con ConPTY).
- Antes de lanzar cada shell se limpia el flag heredable "ignorar Ctrl+C" del proceso
  (`SetConsoleCtrlHandler(NULL, FALSE)`, ver Gotchas).

## Estructura

```
CLAUDE.md
index.html, vite.config.ts, tsconfig.json, package.json
src/                        Frontend (solo render + input)
  main.tsx, App.tsx (título de ventana vía OSC), styles.css
  components/               TerminalView (xterm + addons), SearchBar
  lib/pty.ts                ÚNICO punto que llama a invoke(); wrappers tipados de los comandos
  lib/terminalSession.ts    Conecta un Terminal de xterm con una sesión PTY (buffer de input, restart)
  lib/keybindings.ts        Copiar/pegar, búsqueda, zoom
  lib/clipboard.ts          navigator.clipboard con fallback
  lib/renderer.ts           WebGL con fallback al renderer DOM (también ante pérdida de contexto)
  store/settings.ts         zustand: fuente, cursor, scrollback, tema, zoom
  store/terminal.ts         zustand: título, estado de la sesión, renderer, búsqueda
  config/theme.ts           Tema por defecto
src-tauri/
  src/lib.rs                Builder de Tauri, ciclo de vida de ventanas/página/app
  src/commands.rs           Comandos Tauri finos: validan y delegan en PtyManager
  src/pty/manager.rs        Registro de sesiones (create/write/resize/close/close_owned_by/shutdown)
  src/pty/session.rs        ConPTY + hilos reader/flusher/writer/waiter + batching
  src/pty/job.rs            Job Object KILL_ON_JOB_CLOSE (solo Windows)
  src/pty/shell.rs          pwsh → powershell.exe, cwd inicial = %USERPROFILE%
  src/pty/platform.rs       Build de Windows (RtlGetVersion) para `pty_backend`
  tests/pty.rs              Tests de integración con procesos reales (PowerShell/ConPTY)
e2e/
  run.mjs                   E2E sobre la app real vía CDP de WebView2 (`npm run e2e`)
  fake-agent.mjs            Agente de IA falso para pruebas (ver "Pruebas con agentes")
  win.ps1                   Resize/cierre de la ventana de la app por PID (Win32)
  artifacts/                Capturas y log de `tauri dev` (ignorado por git)
```

## Comandos

```powershell
npm install
npm run tauri dev                       # app en modo desarrollo (Vite + cargo run)
npm run build                           # typecheck (tsc) + build del frontend
npm run tauri build -- --no-bundle      # exe release en src-tauri/target/release/
cd src-tauri; cargo fmt --check; cargo clippy --all-targets -- -D warnings; cargo test
npm run e2e                             # lanza `tauri dev`, corre todas las etapas y cierra la app
npm run e2e -- agent,close              # solo algunas etapas
```

`npm run e2e` necesita los puertos 1420 (Vite) y 9223 (CDP) libres. Abre una ventana real de la
app y usa el portapapeles (lo restaura al terminar). Capturas en `e2e/artifacts/`.

## Pruebas con agentes de IA (regla obligatoria)

- **Ninguna prueba (e2e, de integración ni manual automatizada) envía input a un `claude`,
  `codex` o `gemini` real**, ni siquiera tipear sin Enter: cualquier interacción puede consumir
  uso de la cuenta del usuario (y un agente en *auto mode* puede ejecutar cosas).
- Para probar comportamiento con agentes se usa `e2e/fake-agent.mjs`: editor de línea en raw
  mode, bracketed paste, la secuencia de salto de línea de cada agente y "Ctrl+C dos veces para
  salir". Se ejecuta con un `node.exe` enlazado como `claude.exe` / `gemini.exe`, así la
  detección de agentes de la terminal se prueba con el mismo nombre de imagen que el real.
- `run()` en `e2e/run.mjs` se niega a tipear si el cursor no está en un prompt de PowerShell
  libre: un fallo nunca debe terminar mandando texto a un programa ajeno.

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
- Todo IPC pasa por `src/lib/pty.ts`. Los componentes no llaman a `invoke` directamente.
- Las instancias de `Terminal` (xterm) y addons viven en refs, **nunca** en zustand ni en estado de
  React (son imperativas y no serializables). zustand guarda solo estado serializable.
- Componentes funcionales, uno por archivo, PascalCase.
- Todo efecto que crea recursos (terminal, sesión, observers) los libera en el cleanup y es seguro
  ante el doble montaje de `StrictMode` en dev.

## Regla de fases

**Cada fase tiene que compilar y funcionar antes de empezar la siguiente.** Una fase está
terminada solo si:

1. `npm run build` pasa sin errores.
2. `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings` y `cargo test` pasan.
3. `npm run e2e` pasa completo (cubre automáticamente casi todo el smoke test de abajo).

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
- [ ] Cerrar la ventana no deja `powershell`/`pwsh`/hijos vivos (verificar en el Administrador de tareas).

## Atajos (MVP)

| Atajo | Acción |
|---|---|
| `Ctrl+C` | Copia si hay selección; si no, envía `^C` |
| `Ctrl+Shift+C`, `Ctrl+Insert` | Copiar |
| `Ctrl+V`, `Ctrl+Shift+V`, `Shift+Insert` | Pegar |
| Clic derecho | Copia si hay selección; si no, pega |
| `Ctrl+Shift+F` | Buscar (`Enter` siguiente, `Shift+Enter` anterior, `Esc` cerrar) |
| `Ctrl+=` / `Ctrl+-` / `Ctrl+0` | Zoom de fuente |
| `Ctrl+clic` en un link | Abrir en el navegador |

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
  se da con `inset` en `.terminal-host` (no con padding en `.xterm`) y el viewport es transparente
  y sin scrollbar nativa (ver `styles.css`).
- vim/nano de Git for Windows no están en el `PATH` de PowerShell: usar la ruta completa. El nano
  de MSYS2 se confunde con rutas Windows absolutas al guardar ("Save under DIFFERENT NAME?");
  abrirlo con rutas relativas.
- El portapapeles de Windows tiene un lock global: si otro proceso lo retiene, copiar/pegar puede
  fallar en silencio (visto 1 vez en 24 ciclos durante las pruebas). Si aparece en uso real, mover
  el portapapeles a un comando Rust con reintentos.
- `onBinary` de xterm (reportes de mouse X10 no UTF-8) no se reenvía todavía.

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
- Siguiente candidata — **peso de WebView2**: medir WebGL vs DOM en memoria del proceso GPU,
  probar `--in-process-gpu` (`additionalBrowserArgs`) y `MemoryUsageTargetLevel = Low` al
  minimizar. Es lo que más mueve la aguja frente al objetivo "mucho más liviana que Warp".
- Próximas fases (ideas): pestañas y splits, archivo de configuración (fuente, tema, shell,
  atajos), perfiles de shell, flow control con ACKs para salidas gigantes, `conpty.dll` +
  `OpenConsole.exe` empaquetados (ConPTY más nuevo que el del sistema), `Shift+Enter` para
  multilínea en agentes, notificaciones al terminar comandos largos.
