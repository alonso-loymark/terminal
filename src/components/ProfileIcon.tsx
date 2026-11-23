import { GitBranch, Server, SquareChevronRight, SquareTerminal, Terminal, type LucideIcon } from 'lucide-react';
import type { Profile } from '../config/profiles';

/** Built-in icons, by the names a profile's `icon` takes. */
const ICONS: Record<string, LucideIcon> = {
  powershell: SquareChevronRight,
  pwsh: SquareChevronRight,
  cmd: Terminal,
  git: GitBranch,
  linux: Server,
  terminal: SquareTerminal,
};

/**
 * A profile's icon: one of the built-in names, or the text the user wrote in `icon` (their own
 * choice: an emoji or two letters).
 */
export function ProfileIcon({ profile }: { profile: Pick<Profile, 'icon' | 'name'> | null }) {
  if (!profile) return null;
  const Icon = ICONS[profile.icon];
  if (Icon) return <Icon className="profile-icon" data-icon={profile.icon} aria-hidden="true" />;
  return (
    <span className="profile-icon profile-icon-text" data-icon="custom" aria-hidden="true">
      {[...profile.icon].slice(0, 2).join('')}
    </span>
  );
}
