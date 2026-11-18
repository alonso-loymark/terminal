import { create } from 'zustand';
import { getSystemInfo, type ShellProfile } from '../lib/pty';

/** Facts about the machine, asked to the backend once: home folder and available shells. */
interface SystemState {
  homeDir: string | null;
  shells: ShellProfile[];
}

export const useSystem = create<SystemState>()(() => ({ homeDir: null, shells: [] }));

let loading: Promise<void> | null = null;

export function loadSystemInfo(): Promise<void> {
  return (loading ??= getSystemInfo()
    .then((info) => useSystem.setState({ homeDir: info.homeDir, shells: info.shells }))
    .catch((error: unknown) => console.warn('[terminal] system_info falló', error)));
}
