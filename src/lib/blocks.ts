// Command blocks: with the shell integration marks (OSC 133 A/B/C/D and 633 E), each command
// and its output form a block. A BlockTracker per terminal records where each block starts and
// ends (xterm markers, which follow the lines as the scrollback moves), draws a mark beside it
// (red when the command failed; on hover, the block's menu), moves between blocks
// (Ctrl+↑ / Ctrl+↓) and gives the text of a block (command, output, exit code, folder).
//
// Full-screen programs (vim, htop: the alternate buffer) and AI agents (their TUI draws in the
// normal buffer) never make blocks, and no marks show while they run.
import type { IDisposable, IMarker, Terminal } from '@xterm/xterm';
import { unescapeOsc633 } from './shellIntegration';

/** Blocks kept per terminal (older ones are dropped; the scrollback drops them anyway). */
const MAX_BLOCKS = 1000;

export interface BlockInfo {
  id: number;
  command: string;
  exitCode: number | null;
  /** The pane's folder when the command started. */
  cwd: string | null;
  startedAt: number;
  finishedAt: number;
}

/** A block with its output: the context the AI gets (lib/aiActions.ts). */
export interface BlockText extends BlockInfo {
  output: string;
}

interface Position {
  marker: IMarker;
  x: number;
}

interface Block {
  id: number;
  prompt: IMarker;
  input: Position | null;
  output: Position | null;
  end: Position | null;
  command: string | null;
  exitCode: number | null;
  cwd: string | null;
  startedAt: number;
  finishedAt: number;
  /** Ran a full-screen program or an agent: not a block. */
  interactive: boolean;
}

export interface BlockTrackerOptions {
  /** The pane element: the gutter is drawn inside it, beside the terminal. */
  host: HTMLElement;
  getCwd: () => string | null;
  enabled: () => boolean;
  /** The mark of a block was clicked: open its menu there. */
  onMenu: (blockId: number, x: number, y: number) => void;
  /** AI on (`ai.enabled`): failed blocks offer "Explicar / arreglar" on hover. */
  aiEnabled: () => boolean;
  onExplain: (blockId: number) => void;
}

let nextId = 0;

/** One block as the gutter draws it. */
interface GutterItem {
  id: number;
  exitCode: number | null;
  failed: boolean;
  hovered: boolean;
  selected: boolean;
  explain: boolean;
  y: number;
  height: number;
  left: number;
}

export class BlockTracker implements IDisposable {
  readonly #term: Terminal;
  readonly #options: BlockTrackerOptions;
  readonly #disposables: IDisposable[] = [];
  #blocks: Block[] = [];
  #current: Block | null = null;
  #selected: number | null = null;
  #hovered: number | null = null;
  /** An AI agent runs in the pane (its TUI shares the normal buffer). */
  #agent = false;
  readonly #gutter: HTMLDivElement;
  #frame = 0;
  /** What the gutter shows now (skip redrawing the same thing). */
  #drawn = '';

  constructor(term: Terminal, options: BlockTrackerOptions) {
    this.#term = term;
    this.#options = options;
    this.#gutter = document.createElement('div');
    this.#gutter.className = 'block-gutter';
    options.host.appendChild(this.#gutter);
    const pos = (): Position | null => {
      const marker = term.registerMarker(0);
      return marker ? { marker, x: term.buffer.active.cursorX } : null;
    };
    // Registered after the shell integration's handlers, so these run first; returning false
    // passes every mark on to them.
    this.#disposables.push(
      term.parser.registerOscHandler(133, (data) => {
        const kind = data.charAt(0);
        if (kind === 'A') this.#promptStart();
        else if (kind === 'B' && this.#current) this.#current.input = pos();
        else if (kind === 'C' && this.#current) this.#commandStart(pos());
        else if (kind === 'D') this.#commandEnd(data, pos());
        return false;
      }),
      term.parser.registerOscHandler(633, (data) => {
        if (data.startsWith('E;') && this.#current) this.#current.command = unescapeOsc633(data.slice(2).split(';')[0] ?? '');
        return false;
      }),
      term.buffer.onBufferChange((buffer) => {
        if (buffer.type === 'alternate' && this.#current?.output) this.#current.interactive = true;
        this.render();
      }),
      term.onRender(() => this.render()),
      term.onScroll(() => this.render()),
      // Typing moves away from a selected block.
      term.onData(() => {
        if (this.#selected !== null) {
          this.#selected = null;
          this.render();
        }
      }),
    );
    const onMove = (event: MouseEvent) => {
      // On the block's own buttons the block stays hovered (they may overlap other rows).
      if (event.target instanceof Element && event.target.closest('.block-explain')) return;
      this.#hover(this.#blockAtY(event.clientY));
    };
    const onLeave = () => this.#hover(null);
    options.host.addEventListener('mousemove', onMove);
    options.host.addEventListener('mouseleave', onLeave);
    this.#disposables.push({
      dispose: () => {
        options.host.removeEventListener('mousemove', onMove);
        options.host.removeEventListener('mouseleave', onLeave);
      },
    });
  }

  // ---------------------------------------------------------------- marks

  #promptStart(): void {
    const current = this.#current;
    // A command whose end mark never came (a redefined prompt): it ends here.
    if (current?.output && !current.end) this.#commandEnd('D', this.#positionHere());
    else if (current) this.#discard(current);
    const prompt = this.#term.registerMarker(0);
    if (!prompt) return;
    this.#current = {
      id: ++nextId,
      prompt,
      input: null,
      output: null,
      end: null,
      command: null,
      exitCode: null,
      cwd: null,
      startedAt: 0,
      finishedAt: 0,
      interactive: false,
    };
  }

  #positionHere(): Position | null {
    const marker = this.#term.registerMarker(0);
    return marker ? { marker, x: this.#term.buffer.active.cursorX } : null;
  }

  #commandStart(at: Position | null): void {
    const block = this.#current;
    if (!block || !at) return;
    block.output = at;
    block.startedAt = Date.now();
    block.cwd = this.#options.getCwd();
    block.interactive = this.#agent || this.#term.buffer.active.type === 'alternate';
    this.render();
  }

  #commandEnd(data: string, at: Position | null): void {
    const block = this.#current;
    this.#current = null;
    // A prompt redrawn without a command (Enter on an empty line, Ctrl+C) is no block.
    if (!block?.output || !at || block.interactive) {
      if (block) this.#discard(block);
      at?.marker.dispose();
      this.render();
      return;
    }
    const code = data.split(';')[1];
    block.end = at;
    block.exitCode = code !== undefined && /^-?\d+$/.test(code) ? Number(code) : null;
    block.finishedAt = Date.now();
    if (!block.command) block.command = this.#read(block.input, block.output).trim();
    this.#blocks.push(block);
    while (this.#blocks.length > MAX_BLOCKS) this.#discard(this.#blocks.shift()!);
    this.render();
  }

  #discard(block: Block): void {
    for (const marker of [block.prompt, block.input?.marker, block.output?.marker, block.end?.marker]) marker?.dispose();
  }

  /** An agent started or ended in the pane: its block is not one, and marks hide meanwhile. */
  setAgent(running: boolean): void {
    if (this.#agent === running) return;
    this.#agent = running;
    if (running && this.#current?.output) this.#current.interactive = true;
    this.render();
  }

  // ---------------------------------------------------------------- reading

  /** Finished blocks still in the scrollback, oldest first. */
  #alive(): Block[] {
    this.#blocks = this.#blocks.filter((b) => {
      const dead = b.prompt.isDisposed || b.prompt.line < 0 || !b.end || b.end.marker.isDisposed;
      if (dead) this.#discard(b);
      return !dead;
    });
    return this.#blocks;
  }

  /** First and last buffer line of a block (the end mark sits at the start of the next prompt). */
  #span(block: Block): [number, number] {
    const start = block.prompt.line;
    const end = block.end!;
    const last = end.x === 0 ? end.marker.line - 1 : end.marker.line;
    return [start, Math.max(start, last)];
  }

  /** Text between two positions, wrapped rows joined back into their lines. */
  #read(from: Position | null, to: Position | null): string {
    if (!from || !to || from.marker.isDisposed || to.marker.isDisposed) return '';
    const buffer = this.#term.buffer.normal;
    const last = to.marker.line;
    let text = '';
    for (let y = from.marker.line; y <= last; y++) {
      const line = buffer.getLine(y);
      if (!line) continue;
      let row = line.translateToString(false);
      if (y === last) row = row.slice(0, to.x);
      if (y === from.marker.line) row = row.slice(from.x);
      // A row that continues on the next one (soft wrap) joins it as is.
      const wraps = y < last && !!buffer.getLine(y + 1)?.isWrapped;
      text += wraps ? row : `${row.trimEnd()}${y < last ? '\n' : ''}`;
    }
    return text;
  }

  #info(block: Block): BlockInfo {
    return {
      id: block.id,
      command: block.command ?? '',
      exitCode: block.exitCode,
      cwd: block.cwd,
      startedAt: block.startedAt,
      finishedAt: block.finishedAt,
    };
  }

  list(): BlockInfo[] {
    return this.#alive().map((b) => this.#info(b));
  }

  text(id: number): BlockText | null {
    const block = this.#alive().find((b) => b.id === id);
    if (!block) return null;
    const output = this.#read(block.output, block.end).replace(/^[^\n]*\n/, (first) => (first.trim() ? first : '')).replace(/\s+$/, '');
    return { ...this.#info(block), output };
  }

  get selected(): number | null {
    return this.#selected;
  }

  // ---------------------------------------------------------------- navigation

  /** Marks can show: enabled, normal buffer, no full-screen program or agent running. */
  #shown(): boolean {
    if (!this.#options.enabled() || this.#agent) return false;
    if (this.#term.buffer.active.type !== 'normal') return false;
    return !(this.#current?.output && this.#current.interactive);
  }

  /**
   * Ctrl+↑ / Ctrl+↓: the previous / next block, scrolled into view. False when there is nothing
   * to move to here (the key then goes on to the program).
   */
  navigate(delta: -1 | 1): boolean {
    if (!this.#shown()) return false;
    const list = this.#alive();
    if (list.length === 0) return false;
    let at = this.#selected === null ? -1 : list.findIndex((b) => b.id === this.#selected);
    if (at < 0) {
      if (delta > 0) return false;
      at = list.length;
    }
    const next = at + delta;
    if (next >= list.length) {
      // Past the last one: back to the prompt.
      this.#selected = null;
      this.#term.scrollToBottom();
    } else {
      const block = list[Math.max(0, next)]!;
      this.#selected = block.id;
      const [start, last] = this.#span(block);
      const top = this.#term.buffer.active.viewportY;
      const rows = this.#term.rows;
      if (start < top || last > top + rows - 1) this.#term.scrollToLine(Math.max(0, start - 1));
    }
    this.render();
    return true;
  }

  // ---------------------------------------------------------------- drawing

  #geometry(): { top: number; left: number; cell: number } | null {
    const screen = this.#term.element?.querySelector('.xterm-screen');
    if (!screen || this.#options.host.hidden) return null;
    const rect = screen.getBoundingClientRect();
    const host = this.#options.host.getBoundingClientRect();
    if (rect.height === 0) return null;
    return { top: rect.top - host.top, left: rect.left - host.left, cell: rect.height / this.#term.rows };
  }

  #blockAtY(clientY: number): number | null {
    if (!this.#shown()) return null;
    const screen = this.#term.element?.querySelector('.xterm-screen');
    if (!screen) return null;
    const rect = screen.getBoundingClientRect();
    const row = Math.floor((clientY - rect.top) / (rect.height / this.#term.rows));
    if (row < 0 || row >= this.#term.rows) return null;
    const line = this.#term.buffer.active.viewportY + row;
    const block = this.#alive().find((b) => {
      const [start, last] = this.#span(b);
      return line >= start && line <= last;
    });
    return block?.id ?? null;
  }

  #hover(id: number | null): void {
    if (this.#hovered === id) return;
    this.#hovered = id;
    this.render();
  }

  /** Redraws the gutter on the next frame (scroll, output, resize, hover...). */
  render(): void {
    if (this.#frame) return;
    this.#frame = requestAnimationFrame(() => {
      this.#frame = 0;
      this.#draw();
    });
  }

  #draw(): void {
    const gutter = this.#gutter;
    const geometry = this.#shown() ? this.#geometry() : null;
    const items: GutterItem[] = [];
    if (geometry) {
      const { top, left, cell } = geometry;
      const first = this.#term.buffer.active.viewportY;
      const lastRow = first + this.#term.rows - 1;
      for (const block of this.#alive()) {
        const [start, last] = this.#span(block);
        if (last < first || start > lastRow) continue;
        const failed = block.exitCode !== null && block.exitCode !== 0;
        const hovered = block.id === this.#hovered;
        const selected = block.id === this.#selected;
        if (!failed && !hovered && !selected) continue;
        const from = Math.max(start, first);
        const to = Math.min(last, lastRow);
        items.push({
          id: block.id,
          exitCode: block.exitCode,
          failed,
          hovered,
          selected,
          explain: failed && hovered && this.#options.aiEnabled(),
          y: top + (from - first) * cell,
          height: (to - from + 1) * cell,
          left,
        });
      }
    }
    // xterm renders on every echoed key and cursor blink: touch the DOM only when what the
    // gutter shows changed. Replacing a mark between mousedown and mouseup loses the click.
    const signature = JSON.stringify([!!geometry, items]);
    if (signature === this.#drawn) return;
    this.#drawn = signature;
    gutter.replaceChildren();
    gutter.hidden = !geometry;
    for (const item of items) {
      const { y, height, left } = item;
      if (item.selected) {
        const band = document.createElement('div');
        band.className = 'block-selection';
        band.style.cssText = `top:${y}px;height:${height}px;left:${left}px`;
        gutter.appendChild(band);
      }
      const mark = document.createElement('button');
      mark.type = 'button';
      mark.className = 'block-mark';
      mark.dataset.blockId = String(item.id);
      mark.dataset.status = item.failed ? 'error' : 'ok';
      if (item.hovered) mark.dataset.hover = '';
      if (item.selected) mark.dataset.selected = '';
      mark.title = item.failed ? `Falló (código ${item.exitCode}): acciones del bloque` : 'Acciones del bloque';
      mark.setAttribute('aria-label', mark.title);
      mark.style.cssText = `top:${y}px;height:${height}px;left:${Math.max(0, left - 7)}px`;
      mark.addEventListener('pointerdown', (event) => event.preventDefault());
      mark.addEventListener('click', (event) => {
        event.stopPropagation();
        this.#options.onMenu(item.id, event.clientX, event.clientY);
      });
      gutter.appendChild(mark);
      if (item.explain) {
        // Explain / fix with the AI (the answer streams in the AI panel).
        const explain = document.createElement('button');
        explain.type = 'button';
        explain.className = 'block-explain';
        explain.dataset.action = 'explain-block';
        explain.dataset.blockId = String(item.id);
        explain.textContent = 'Explicar / arreglar';
        explain.title = 'Explicar por qué falló y proponer un arreglo (IA)';
        // On the block's first row, at the right: hovering it keeps this block hovered.
        explain.style.cssText = `top:${y}px;right:16px`;
        explain.addEventListener('pointerdown', (event) => event.preventDefault());
        explain.addEventListener('click', (event) => {
          event.stopPropagation();
          this.#options.onExplain(item.id);
        });
        gutter.appendChild(explain);
      }
    }
  }

  dispose(): void {
    cancelAnimationFrame(this.#frame);
    for (const d of this.#disposables) d.dispose();
    for (const block of this.#blocks) this.#discard(block);
    if (this.#current) this.#discard(this.#current);
    this.#blocks = [];
    this.#current = null;
    this.#gutter.remove();
  }
}
