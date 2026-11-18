// Shell integration: turns the OSC sequences written by the scripts in
// src-tauri/resources/shell-integration into events. Parsing is pure (no runtime imports), so
// `node --test` covers it; `registerShellIntegration` wires it into an xterm instance.
//
// Protocol (same marks as VS Code and Windows Terminal):
//   OSC 7 ; file://<host>/<percent-encoded path>      current folder, at every prompt
//   OSC 133 ; A / B / C / D;<exit code>               prompt start / end, command start / end
//   OSC 633 ; E ; <command line, VS Code escaping>    the command about to run
//   OSC 633 ; P ; Shell=<name> | IntegrationError=<message>   loaded / failed to load
import type { IDisposable, Terminal } from '@xterm/xterm';
import type { ShellEvent } from '../store/workspaceModel';

export type { ShellEvent };

/**
 * file://host/C:/Users/Ana%20Mar%C3%ADa → C:\Users\Ana María. Without a drive the host is a
 * UNC server: file://server/share/dir → \\server\share\dir. Anything else: null.
 */
export function cwdFromFileUri(uri: string): string | null {
  const match = /^file:\/\/([^/]*)(\/.*)?$/i.exec(uri.trim());
  if (!match) return null;
  let path: string;
  try {
    path = decodeURIComponent(match[2] ?? '/');
  } catch {
    return null;
  }
  const drive = /^\/([A-Za-z]):(\/.*)?$/.exec(path);
  if (drive) return `${drive[1]!.toUpperCase()}:${(drive[2] ?? '/').replace(/\//g, '\\')}`;
  const host = match[1] ?? '';
  if (!host || host.toLowerCase() === 'localhost') return null;
  return `\\\\${host}${path.replace(/\//g, '\\')}`.replace(/\\$/, '');
}

/** Reverses VS Code's OSC 633 escaping: \\ and \xHH. */
export function unescapeOsc633(value: string): string {
  return value.replace(/\\(\\|x([0-9a-fA-F]{2}))/g, (_, escaped: string, hex: string | undefined) =>
    hex ? String.fromCharCode(Number.parseInt(hex, 16)) : escaped,
  );
}

/** OSC 133 payload (without the number): A, B, C, D[;code]. B carries nothing we need. */
export function parseOsc133(data: string): ShellEvent | null {
  const [kind, code] = data.split(';');
  switch (kind) {
    case 'A':
      return { type: 'prompt' };
    case 'C':
      return { type: 'commandStart' };
    case 'D': {
      const exitCode = code !== undefined && /^-?\d+$/.test(code) ? Number(code) : null;
      return { type: 'commandEnd', exitCode };
    }
    default:
      return null;
  }
}

/** OSC 633 payload: E;<command line> or P;Key=Value. */
export function parseOsc633(data: string): ShellEvent | null {
  const at = data.indexOf(';');
  const kind = at < 0 ? data : data.slice(0, at);
  const rest = at < 0 ? '' : data.slice(at + 1);
  if (kind === 'E') {
    // VS Code may append ";<nonce>"; the command line itself has its semicolons escaped.
    return { type: 'commandLine', commandLine: unescapeOsc633(rest.split(';')[0] ?? '') };
  }
  if (kind === 'P') {
    const eq = rest.indexOf('=');
    const key = eq < 0 ? rest : rest.slice(0, eq);
    const value = eq < 0 ? '' : rest.slice(eq + 1);
    if (key === 'Shell') return { type: 'integration', ok: true };
    if (key === 'IntegrationError') return { type: 'integration', ok: false, error: value.trim() };
  }
  return null;
}

/** Registers the OSC handlers on a terminal; events go to `emit`. */
export function registerShellIntegration(term: Terminal, emit: (event: ShellEvent) => void): IDisposable {
  const handle = (parse: (data: string) => ShellEvent | null) => (data: string) => {
    const event = parse(data);
    if (event) emit(event);
    return true; // handled: nothing else should act on these
  };
  const disposables = [
    term.parser.registerOscHandler(7, handle((data) => {
      const cwd = cwdFromFileUri(data);
      return cwd ? { type: 'cwd', cwd } : null;
    })),
    term.parser.registerOscHandler(133, handle(parseOsc133)),
    term.parser.registerOscHandler(633, handle(parseOsc633)),
  ];
  return { dispose: () => disposables.forEach((d) => d.dispose()) };
}
