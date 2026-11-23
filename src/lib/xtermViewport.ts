import type { Terminal } from '@xterm/xterm';

/** The parts of xterm's (private) Viewport this patch needs. */
interface ViewportInternals {
  _sync?: (ydisp?: number) => void;
  _renderService?: { addRefreshCallback?: (callback: () => void) => number };
  __brisaCoalesced?: true;
}

/**
 * xterm 6.0 syncs its scrollbar (scroll height and position, DOM writes and a fade timer) on
 * every line the buffer scrolls: an agent repainting a long transcript is thousands of syncs
 * per frame, ~15% of the main thread with two agents (measured with the perf e2e). Once per
 * frame is enough: the rows are drawn once per frame too. Calls with an explicit position
 * (xterm's own once-per-frame `queueSync`) pass through.
 *
 * Private API, so feature-detected: if xterm changes it nothing is patched and the perf e2e
 * says so (it checks the marker). Still per line upstream in 6.1.0-beta.339.
 */
export function coalesceViewportSync(term: Terminal): boolean {
  const viewport = (term as unknown as { _core?: { _viewport?: ViewportInternals } })._core?._viewport;
  const sync = viewport?._sync;
  const refresh = viewport?._renderService?.addRefreshCallback;
  if (!viewport || typeof sync !== 'function' || typeof refresh !== 'function') return false;
  if (viewport.__brisaCoalesced) return true;
  const renderService = viewport._renderService;
  let queued = false;
  viewport._sync = (ydisp?: number) => {
    if (ydisp !== undefined) {
      sync.call(viewport, ydisp);
      return;
    }
    if (queued) return;
    queued = true;
    // Runs on xterm's next render frame, right after the rows are drawn.
    refresh.call(renderService, () => {
      queued = false;
      sync.call(viewport);
    });
  };
  viewport.__brisaCoalesced = true;
  return true;
}
