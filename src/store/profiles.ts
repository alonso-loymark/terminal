// Profiles in use: the shells the backend found merged with settings.json (config/profiles.ts),
// recomputed only when either changes.
import { pickProfile, resolveProfiles, type Profile, type ResolvedProfiles } from '../config/profiles';
import { useSettings } from './settings';
import { useSystem } from './system';
import type { ProfileId } from './workspaceModel';

let cache: { shells: unknown; config: unknown; result: ResolvedProfiles } | null = null;

export function currentProfiles(): ResolvedProfiles {
  const shells = useSystem.getState().shells;
  const config = useSettings.getState().settings.profiles;
  if (!cache || cache.shells !== shells || cache.config !== config) {
    cache = { shells, config, result: resolveProfiles(shells, config) };
  }
  return cache.result;
}

/** The profile `id`, else the default one. */
export const profileFor = (id: ProfileId | null | undefined): Profile | null => pickProfile(currentProfiles(), id);

/** Re-renders when the detected shells or the profile settings change. */
export function useProfiles(): ResolvedProfiles {
  useSystem((s) => s.shells);
  useSettings((s) => s.settings.profiles);
  return currentProfiles();
}

/** A profile's display data (for tabs, menus and the status bar). */
export function useProfile(id: ProfileId | null | undefined): Profile | null {
  const resolved = useProfiles();
  return pickProfile(resolved, id);
}
