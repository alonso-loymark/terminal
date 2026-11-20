# Brisa

Terminal de escritorio para Windows, liviana y personalizable, pensada para trabajar con agentes
de IA (Claude Code, Codex, Gemini CLI). Construida con Tauri 2 (Rust + WebView2), React,
TypeScript y xterm.js sobre ConPTY.

- Rust maneja los procesos (PTY, ciclo de vida, limpieza del árbol de procesos); el frontend solo
  renderiza y reenvía input.
- Tabs con grupos estilo Chrome y paneles divididos; las terminales nunca se recrean al moverlas.
- Shell integration para PowerShell (5.1 y 7), Git Bash y bash en WSL (cmd: solo la carpeta):
  carpeta actual en la barra de estado y en la tab, estado y código de salida de cada comando, y
  paneles/tabs nuevos en la misma carpeta. No toca el perfil del usuario.
- Explorador de archivos que sigue la carpeta del panel activo, con git y vigilancia de cambios.
- Configuración en `settings.json` (con comentarios, autocompletado en VS Code y cambios en vivo)
  y una pantalla de configuración (`Ctrl+,`): fuente, cursor, márgenes, ligaduras, opacidad y
  Mica/Acrylic; temas incluidos (Oscuro, Claro, Catppuccin, Dracula, Tokyo Night, One Dark) e
  importables (JSON o esquemas de Windows Terminal) que pintan también la interfaz; perfiles de
  shell (detectados y propios, con ícono, argumentos, carpeta, variables y tema).
- Atajos de teclado configurables (pantalla o `keybindings` en settings.json), con detección de
  conflictos entre acciones y con las teclas que necesitan los programas (Ctrl+C, Ctrl+W, Ctrl+R…).
- Paleta de comandos (`Ctrl+Shift+P`) con búsqueda difusa: acciones con su atajo, tabs y paneles
  por nombre, perfiles, temas y layouts; lo usado recientemente primero.
- Sesión: al reabrir vuelven las tabs, grupos, nombres, colores, paneles con sus tamaños, y el
  perfil y la carpeta de cada panel (desactivable).
- Layouts guardados (`layouts.json`, editable a mano): una tab o la ventana entera con un nombre,
  y un comando inicial por panel que se escribe cuando la shell está lista.
- Bloques de comandos (con la integración de shell): cada comando con su salida, marca roja si
  falló, menú para copiar o volver a ejecutar, `Ctrl+↑` / `Ctrl+↓` para saltar entre ellos.
- Agentes de IA (Claude Code, Codex, Gemini CLI): indicador en la tab y el panel (trabajando,
  esperando tu respuesta, terminado) y notificaciones de Windows cuando un panel que no está a
  la vista pide atención (BEL, OSC 9, OSC 777); el clic trae ese panel al frente. Preset
  "multi-agente aquí" con un git worktree por panel, que se limpia al cerrar. Todo local.
- IA (desactivable con `"ai.enabled": false`): "Explicar / arreglar" en los comandos que
  fallaron, lenguaje natural a comando (`Ctrl+I`) y un chat corto sobre la terminal
  (`Ctrl+Shift+I`). Usa Claude Code (`claude -p`, con tu suscripción, sin herramientas ni
  acceso a archivos) o la API de Anthropic (la API key queda en el Administrador de credenciales
  de Windows). Antes de enviar nada oculta tokens, API keys, contraseñas, connection strings y
  archivos .env; "Ver qué se envía" muestra exactamente qué sale; ningún comando sugerido se
  ejecuta solo y los destructivos se marcan.
- Modo orquestador (desactivable con `"orchestrator.enabled": false`): una tab "Orquestador" por
  proyecto con un chat que, por cada mensaje, propone un plan (la tarea, qué agente, qué modelo y
  qué esfuerzo, y por qué) y lo ejecuta con Claude Code (tu suscripción) cuando lo aprobás: ves en
  vivo qué lee, edita y ejecuta, y al final el resumen, el diff, los tokens y el costo. Los
  trabajadores editan archivos y solo ejecutan los comandos de build, tests y lint del proyecto;
  cualquier otra cosa se te pregunta. Los modelos salen de tu Claude Code; `@haiku`, `@sonnet` u
  `@opus` fuerza uno. Ofrece generar un `AGENTS.md` (y el `CLAUDE.md` que lo importa) mostrando
  el contenido antes de crear nada, sin commits. La conversación y el registro de decisiones se
  guardan en la configuración de Brisa, nunca en el repo.
- Renderizado con WebGL (fallback DOM), búsqueda, links clickeables, copiar/pegar estilo Windows
  Terminal (o menú contextual) y zoom.
- Barra de título propia con las tabs, como Windows Terminal: arrastrar la ventana desde el espacio
  vacío, doble clic para maximizar y Snap Layouts de Windows 11 sobre el botón de maximizar (o la
  barra nativa, con `"appearance.titleBar": "native"`). Un radio de esquinas para toda la interfaz
  (`"appearance.cornerRadius"`: 0 = todo cuadrado; mayor, paneles y explorador como tarjetas) y
  colores de barras, explorador y terminal derivados del mismo tema.

La configuración vive en `%APPDATA%\dev.brisa.desktop\`. Si existe la de la versión anterior
(`%APPDATA%\dev.terminal.desktop`, cuando la app se llamaba "Terminal"), se migra sola al primer
arranque, temas importados incluidos.

## Requisitos

- Windows 10/11 con WebView2
- Rust (toolchain MSVC) y Node.js 24+

## Uso

```powershell
npm install
npm run tauri dev                    # desarrollo
npm run tauri build -- --no-bundle   # ejecutable release (brisa.exe) en src-tauri/target/release/
npm run e2e                          # pruebas end-to-end sobre la app real
```

Arquitectura, convenciones y reglas de trabajo: ver [CLAUDE.md](CLAUDE.md).
