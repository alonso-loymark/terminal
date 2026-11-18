import { WebglAddon } from '@xterm/addon-webgl';
import type { Terminal } from '@xterm/xterm';

export type RendererKind = 'webgl' | 'dom';

/**
 * WebGL only while the terminal is on screen. Chromium keeps ~16 WebGL contexts per page and
 * drops the oldest beyond that, so hidden terminals (other tabs, zoomed-out panes) release
 * theirs and fall back to xterm's DOM renderer, which costs nothing while display: none.
 */
export class GpuRenderer {
  readonly #term: Terminal;
  readonly #onChange: (kind: RendererKind) => void;
  #webgl: WebglAddon | null = null;

  constructor(term: Terminal, onChange: (kind: RendererKind) => void) {
    this.#term = term;
    this.#onChange = onChange;
  }

  /** Loads WebGL; on failure (or a later context loss) xterm keeps the DOM renderer. */
  attach(): RendererKind {
    if (this.#webgl) return 'webgl';
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        webgl.dispose();
        if (this.#webgl === webgl) this.#webgl = null;
        this.#onChange('dom');
      });
      this.#term.loadAddon(webgl);
      this.#webgl = webgl;
      this.#onChange('webgl');
      return 'webgl';
    } catch (error) {
      console.warn('[terminal] WebGL no disponible, se usa el renderer DOM', error);
      this.#onChange('dom');
      return 'dom';
    }
  }

  /** Releases the WebGL context (the terminal is being hidden). */
  detach(): void {
    const webgl = this.#webgl;
    if (!webgl) return;
    this.#webgl = null;
    // dispose() removes the canvas, but Chromium keeps counting its context as live until it is
    // garbage collected, and past ~16 it starts dropping the oldest ones (possibly a visible
    // terminal's). Losing it explicitly frees the slot right away. getContext on a canvas that
    // already has a 2D context returns null, so only the WebGL one is touched.
    const contexts = [...(this.#term.element?.querySelectorAll('canvas') ?? [])]
      .map((canvas) => canvas.getContext('webgl2'))
      .filter((gl): gl is WebGL2RenderingContext => gl !== null);
    webgl.dispose();
    for (const gl of contexts) gl.getExtension('WEBGL_lose_context')?.loseContext();
    this.#onChange('dom');
  }
}
