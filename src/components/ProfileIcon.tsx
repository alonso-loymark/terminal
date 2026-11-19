import type { Profile } from '../config/profiles';

/** Built-in icons: a small monogram badge (no image files to ship). */
const BADGES: Record<string, { text: string; background: string; color: string }> = {
  powershell: { text: 'PS', background: '#012456', color: '#ffffff' },
  pwsh: { text: 'PS', background: '#2b5797', color: '#ffffff' },
  cmd: { text: '>_', background: '#1e1e1e', color: '#cccccc' },
  git: { text: '$', background: '#f05033', color: '#ffffff' },
  linux: { text: '🐧', background: 'transparent', color: 'inherit' },
  terminal: { text: '>_', background: 'var(--border)', color: 'var(--text)' },
};

/** A profile's icon: one of the built-in names, or the user's emoji / short text. */
export function ProfileIcon({ profile }: { profile: Pick<Profile, 'icon' | 'name'> | null }) {
  if (!profile) return null;
  const badge = BADGES[profile.icon];
  if (badge) {
    return (
      <span className="profile-icon" data-icon={profile.icon} style={{ background: badge.background, color: badge.color }} aria-hidden="true">
        {badge.text}
      </span>
    );
  }
  return (
    <span className="profile-icon" data-icon="custom" aria-hidden="true">
      {[...profile.icon].slice(0, 2).join('')}
    </span>
  );
}
