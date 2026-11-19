// Shell profiles: the shells the backend detected (PowerShell 7, Windows PowerShell, cmd, Git
// Bash, each WSL distribution) merged with the user's `profiles.list` from settings.json. An
// entry with a detected id customizes that profile; any other entry is a profile of its own and
// needs a command. Pure (tested with node --test).
import type { Issue } from './schema.ts';
import type { ShellKind } from '../store/workspaceModel.ts';

export type ProfileId = string;

/** What the backend found (`system_info`). */
export interface DetectedShell {
  id: string;
  kind: ShellKind;
  name: string;
  program: string;
  distro: string | null;
}

/** A `profiles.list` entry as validated from settings.json (every field optional). */
export interface ProfileEntry {
  id?: string;
  name?: string;
  icon?: string;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  theme?: string;
  hidden?: boolean;
}

export interface Profile {
  id: ProfileId;
  name: string;
  /** Built-in icon name (see PROFILE_ICONS) or a short text / emoji. */
  icon: string;
  /** Null for a custom command: the backend guesses it from the program's name. */
  kind: ShellKind | null;
  /** Null: the detected program for `kind`. */
  program: string | null;
  /** Null: the defaults (which carry the shell integration). */
  args: string[] | null;
  /** Starting folder for new tabs (%VAR% and ~ allowed); null: the active pane's folder. */
  cwd: string | null;
  env: Record<string, string>;
  /** Theme for this profile's terminals; null: the global one. */
  theme: string | null;
  hidden: boolean;
  distro: string | null;
  /** Found on this machine (as opposed to the user's own). */
  detected: boolean;
}

/** What `create_session` gets to start a profile (see ShellSpec in src-tauri/src/pty/shell.rs). */
export interface ShellSpec {
  kind: ShellKind | null;
  program: string | null;
  args: string[] | null;
  env: Record<string, string>;
  distro: string | null;
}

export const PROFILE_ICONS = ['powershell', 'pwsh', 'cmd', 'git', 'linux', 'terminal'] as const;

const ICON_BY_KIND: Record<ShellKind, string> = {
  powershell: 'powershell',
  pwsh: 'pwsh',
  cmd: 'cmd',
  gitbash: 'git',
  wsl: 'linux',
  other: 'terminal',
};

/** Ids of the profiles the backend may detect on some machine (customizing one that is absent is fine). */
const KNOWN_IDS = /^(pwsh|powershell|cmd|gitbash|wsl-.+)$/;

const baseName = (program: string) => program.split(/[\\/]/).pop()?.replace(/\.exe$/i, '') || program;
const slug = (text: string) =>
  text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'perfil';

export interface ResolvedProfiles {
  /** Detected profiles first (in the backend's order), then the user's own. */
  profiles: Profile[];
  defaultId: ProfileId | null;
  issues: Issue[];
}

export function resolveProfiles(
  detected: readonly DetectedShell[],
  config: { default: string | null; list: readonly ProfileEntry[] },
): ResolvedProfiles {
  const issues: Issue[] = [];
  const profiles: Profile[] = detected.map((shell) => ({
    id: shell.id,
    name: shell.name,
    icon: ICON_BY_KIND[shell.kind],
    kind: shell.kind,
    program: null,
    args: null,
    cwd: null,
    env: {},
    theme: null,
    hidden: false,
    distro: shell.distro,
    detected: true,
  }));
  const byId = new Map(profiles.map((p) => [p.id, p]));

  config.list.forEach((entry, i) => {
    const path = `profiles.list[${i}]`;
    const command = entry.command?.trim() || null;
    const existing = entry.id ? byId.get(entry.id) : undefined;
    if (existing) {
      // Customizing a detected profile: only what the entry says changes.
      if (entry.name?.trim()) existing.name = entry.name.trim();
      if (entry.icon?.trim()) existing.icon = entry.icon.trim();
      if (command) {
        existing.program = command;
        existing.kind = null;
      }
      if (entry.args) existing.args = entry.args;
      if (entry.cwd?.trim()) existing.cwd = entry.cwd.trim();
      if (entry.env) existing.env = { ...entry.env };
      if (entry.theme?.trim()) existing.theme = entry.theme.trim();
      if (entry.hidden !== undefined) existing.hidden = entry.hidden;
      return;
    }
    if (!command) {
      // A detected profile that is not installed here (settings shared between machines).
      if (!entry.id || !KNOWN_IDS.test(entry.id)) {
        issues.push({ path, message: 'un perfil propio necesita "command": se ignora', severity: 'warning' });
      }
      return;
    }
    let id = entry.id?.trim() || `custom-${slug(entry.name ?? baseName(command))}`;
    for (let n = 2; byId.has(id); n++) id = `${entry.id?.trim() || id.replace(/-\d+$/, '')}-${n}`;
    const profile: Profile = {
      id,
      name: entry.name?.trim() || baseName(command),
      icon: entry.icon?.trim() || 'terminal',
      kind: null,
      program: command,
      args: entry.args ?? null,
      cwd: entry.cwd?.trim() || null,
      env: { ...(entry.env ?? {}) },
      theme: entry.theme?.trim() || null,
      hidden: entry.hidden ?? false,
      distro: null,
      detected: false,
    };
    profiles.push(profile);
    byId.set(id, profile);
  });

  let defaultId = profiles[0]?.id ?? null;
  if (config.default) {
    if (byId.has(config.default)) defaultId = config.default;
    else issues.push({ path: 'profiles.default', message: `no hay un perfil "${config.default}": se usa ${defaultId}`, severity: 'warning' });
  }
  return { profiles, defaultId, issues };
}

/** The profile `id`, else the default one (a pane whose profile was removed restarts with it). */
export function pickProfile(resolved: ResolvedProfiles, id: ProfileId | null | undefined): Profile | null {
  const byId = (pid: ProfileId | null | undefined) => (pid ? resolved.profiles.find((p) => p.id === pid) : undefined);
  return byId(id) ?? byId(resolved.defaultId) ?? resolved.profiles[0] ?? null;
}

export function shellSpec(profile: Profile): ShellSpec {
  return { kind: profile.kind, program: profile.program, args: profile.args, env: profile.env, distro: profile.distro };
}
