import type { Terminal } from '@xterm/xterm';
import { WebglAddon } from '@xterm/addon-webgl';

export type RendererKind = 'webgl' | 'dom';

/**
 * Loads the WebGL renderer, falling back to xterm's built-in DOM renderer when WebGL is not
 * available or its context is lost later (GPU reset, driver update, sleep...).
 * Must be called after `term.open()`.
 */
export function loadRenderer(term: Terminal, onChange: (kind: RendererKind) => void): RendererKind {
  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => {
      webgl.dispose();
      onChange('dom');
    });
    term.loadAddon(webgl);
    return 'webgl';
  } catch (error) {
    console.warn('[terminal] WebGL no disponible, se usa el renderer DOM', error);
    return 'dom';
  }
}
