# Terminal

Terminal de escritorio para Windows, liviana y personalizable, pensada para trabajar con agentes
de IA (Claude Code, Codex, Gemini CLI). Construida con Tauri 2 (Rust + WebView2), React,
TypeScript y xterm.js sobre ConPTY.

- Rust maneja los procesos (PTY, ciclo de vida, limpieza del árbol de procesos); el frontend solo
  renderiza y reenvía input.
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
