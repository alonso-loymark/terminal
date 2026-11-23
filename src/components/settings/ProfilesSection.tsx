import { useMemo, useState } from 'react';
import type { Profile } from '../../config/profiles';
import { allThemes } from '../../config/themes';
import {
  addProfile,
  editProfile,
  formatEnv,
  parseEnv,
  removeProfileEntry,
  setDefaultProfile,
} from '../../lib/settingsActions';
import { useProfiles } from '../../store/profiles';
import { useSettings } from '../../store/settings';
import { useSystem } from '../../store/system';
import { ProfileIcon } from '../ProfileIcon';
import { Field, Select, TextInput, Toggle } from './Controls';

const ICONS = ['powershell', 'pwsh', 'cmd', 'git', 'linux', 'terminal'];

/** The form of one profile. Empty fields go back to the detected / default value. */
function ProfileForm({ profile, locked }: { profile: Profile; locked: boolean }) {
  const entry = useSettings((s) => s.settings.profiles.list.find((e) => e.id === profile.id));
  const custom = useSettings((s) => s.settings.themes);
  const detectedProgram = useSystem((s) => s.shells.find((shell) => shell.id === profile.id)?.program);
  const themes = useMemo(() => allThemes(custom), [custom]);
  const id = profile.id;
  return (
    <div className="profile-form">
      <Field label="Nombre" setting={`profiles.list[${id}].name`}>
        {(fid) => <TextInput id={fid} value={entry?.name ?? ''} placeholder={profile.name} disabled={locked} onCommit={(v) => editProfile(id, 'name', v.trim())} />}
      </Field>
      <Field label="Ícono" setting={`profiles.list[${id}].icon`} hint="Un emoji o texto corto, o: powershell, pwsh, cmd, git, linux, terminal.">
        {(fid) => <TextInput id={fid} value={entry?.icon ?? ''} placeholder={profile.icon} suggestions={ICONS} disabled={locked} onCommit={(v) => editProfile(id, 'icon', v.trim())} />}
      </Field>
      <Field label="Comando" setting={`profiles.list[${id}].command`} hint={profile.detected ? 'Vacío: el programa detectado.' : 'Ruta o nombre en el PATH; admite %VARIABLES%.'}>
        {(fid) => (
          <TextInput id={fid} value={entry?.command ?? ''} placeholder={detectedProgram ?? 'programa.exe'} disabled={locked} onCommit={(v) => editProfile(id, 'command', v.trim())} />
        )}
      </Field>
      <Field label="Argumentos" setting={`profiles.list[${id}].args`} hint="Uno por línea. Vacío: los de siempre, con integración de shell.">
        {(fid) => (
          <TextInput
            id={fid}
            multiline
            value={(entry?.args ?? []).join('\n')}
            disabled={locked}
            onCommit={(v) => editProfile(id, 'args', v.split('\n').map((a) => a.trim()).filter(Boolean))}
          />
        )}
      </Field>
      <Field label="Carpeta inicial" setting={`profiles.list[${id}].cwd`} hint="Para las tabs nuevas con este perfil (admite ~ y %VARIABLES%). Vacío: la del panel activo.">
        {(fid) => <TextInput id={fid} value={entry?.cwd ?? ''} placeholder="~" disabled={locked} onCommit={(v) => editProfile(id, 'cwd', v.trim())} />}
      </Field>
      <Field label="Variables de entorno" setting={`profiles.list[${id}].env`} hint="NOMBRE=valor, una por línea.">
        {(fid) => <TextInput id={fid} multiline value={formatEnv(entry?.env)} disabled={locked} onCommit={(v) => editProfile(id, 'env', parseEnv(v))} />}
      </Field>
      <Field label="Tema" setting={`profiles.list[${id}].theme`}>
        {(fid) => (
          <Select
            id={fid}
            value={entry?.theme ?? ''}
            disabled={locked}
            options={[['', 'El tema global'], ...themes.map((t) => [t.id, t.label] as const)]}
            onCommit={(v) => editProfile(id, 'theme', v)}
          />
        )}
      </Field>
      <Field label="Oculto en el menú" setting={`profiles.list[${id}].hidden`}>
        {(fid) => <Toggle id={fid} value={profile.hidden} disabled={locked} onCommit={(v) => editProfile(id, 'hidden', v || undefined)} />}
      </Field>
      {entry && (
        <div className="profile-actions">
          <button type="button" className="settings-button" data-action="remove-profile" disabled={locked} onClick={() => removeProfileEntry(id)}>
            {profile.detected ? 'Restablecer' : 'Eliminar perfil'}
          </button>
        </div>
      )}
    </div>
  );
}

export function ProfilesSection() {
  const { profiles, defaultId, issues } = useProfiles();
  const locked = useSettings((s) => s.status === 'invalid');
  const [open, setOpen] = useState<string | null>(null);
  return (
    <section className="settings-section" aria-label="Perfiles">
      <h2>Perfiles</h2>
      <p className="settings-intro">Las shells detectadas en esta máquina más las tuyas. El menú de la flecha junto al «+» de las tabs las lista todas.</p>
      <Field label="Perfil por defecto" setting="profiles.default" hint="El de Ctrl+Shift+T y el botón +.">
        {(id) => (
          <Select
            id={id}
            value={defaultId ?? ''}
            disabled={locked}
            options={profiles.map((p) => [p.id, p.name] as const)}
            onCommit={(v) => setDefaultProfile(v)}
          />
        )}
      </Field>
      {issues.map((issue, i) => (
        <p key={i} className="settings-warning" role="status">
          {issue.path}: {issue.message}
        </p>
      ))}
      <ul className="profile-list">
        {profiles.map((profile) => (
          <li key={profile.id} className="profile-item" data-profile={profile.id} data-open={open === profile.id || undefined}>
            <button type="button" className="profile-row" aria-expanded={open === profile.id} onClick={() => setOpen(open === profile.id ? null : profile.id)}>
              <ProfileIcon profile={profile} />
              <span className="profile-name">{profile.name}</span>
              {profile.id === defaultId && <span className="profile-badge">por defecto</span>}
              {profile.hidden && <span className="profile-badge">oculto</span>}
              <span className="profile-kind">{profile.detected ? profile.id : 'propio'}</span>
            </button>
            {open === profile.id && <ProfileForm profile={profile} locked={locked} />}
          </li>
        ))}
      </ul>
      <button type="button" className="settings-button" data-action="add-profile" disabled={locked} onClick={() => setOpen(addProfile())}>
        Nuevo perfil
      </button>
    </section>
  );
}
