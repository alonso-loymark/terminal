# Terminal

Terminal de escritorio para Windows, liviana y personalizable, pensada para trabajar con agentes
de IA (Claude Code, Codex, Gemini CLI). Construida con Tauri 2 (Rust + WebView2), React,
TypeScript y xterm.js sobre ConPTY.

- Rust maneja los procesos (PTY, ciclo de vida, limpieza del árbol de procesos); el frontend solo
  renderiza y reenvía input.
- Tabs con grupos estilo Chrome y paneles divididos; las terminales nunca se recrean al moverlas.
- Shell integration para PowerShell (5.1 y 7) y Git Bash: carpeta actual en la barra de estado y
  en la tab, estado y código de salida de cada comando, y paneles/tabs nuevos en la misma carpeta.
  No toca el perfil del usuario.
- Renderizado con WebGL (fallback DOM), búsqueda, links clickeables, copiar/pegar estilo Windows
  Terminal y zoom.

## Requisitos

- Windows 10/11 con WebView2
- Rust (toolchain MSVC) y Node.js 20+

## Uso

```powershell
npm install
npm run tauri dev                    # desarrollo
npm run tauri build -- --no-bundle   # ejecutable release en src-tauri/target/release/
npm run e2e                          # pruebas end-to-end sobre la app real
```

Arquitectura, convenciones y reglas de trabajo: ver [CLAUDE.md](CLAUDE.md).
