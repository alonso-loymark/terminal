// Command blocks, AI agents, notifications and the worktrees Brisa created (settings screen).
import { useCallback, useEffect, useState } from 'react';
import { AGENT_LABELS } from '../../lib/agentMonitor';
import { worktreeList, worktreeRemove, worktreeStatus, type Worktree, type WorktreeStatus } from '../../lib/fsApi';
import { setSetting } from '../../lib/settingsSync';
import { useSettings } from '../../store/settings';
import { useUi } from '../../store/ui';
import type { AgentName } from '../../store/workspaceModel';
import { Field, NumberInput, TextInput, Toggle } from './Controls';

const useLocked = () => useSettings((s) => s.status === 'invalid');

/** Worktrees of the multi-agent preset that are still there (kept with changes, or in use). */
function WorktreeList() {
  const [items, setItems] = useState<{ worktree: Worktree; status: WorktreeStatus | null }[] | null>(null);
  const load = useCallback(() => {
    void worktreeList()
      .then(async (list) => setItems(await Promise.all(list.map(async (worktree) => ({ worktree, status: await worktreeStatus(worktree.path).catch(() => null) })))))
      .catch(() => setItems([]));
  }, []);
  useEffect(load, [load]);
  if (items === null) return <p className="settings-hint">Cargando…</p>;
  if (items.length === 0) return <p className="settings-hint">Ninguno: los worktrees se borran al cerrar su panel.</p>;
  return (
    <ul className="layout-list">
      {items.map(({ worktree, status }) => (
        <li key={worktree.path} className="layout-item" data-worktree={worktree.path}>
          <span className="layout-name" title={worktree.path}>
            {worktree.branch}
          </span>
          <span className="layout-summary" title={worktree.path}>
            {status && !status.exists ? 'ya no existe' : status?.changes ? `${status.changes} cambios sin commitear` : 'sin cambios'}
          </span>
          <button
            type="button"
            className="settings-button"
            data-action="remove-worktree"
            data-danger={status?.changes ? '' : undefined}
            onClick={() => {
              void worktreeRemove(worktree.path, true)
                .catch((error: unknown) => useUi.getState().showToast(`No se pudo borrar: ${String(error)}`, 'warning'))
                .finally(load);
            }}
          >
            {status?.changes ? 'Borrar (se pierden los cambios)' : 'Borrar'}
          </button>
        </li>
      ))}
    </ul>
  );
}

export function AgentsSection() {
  const blocks = useSettings((s) => s.settings.blocks);
  const agents = useSettings((s) => s.settings.agents);
  const notifications = useSettings((s) => s.settings.notifications);
  const locked = useLocked();
  return (
    <section className="settings-section" aria-label="Bloques y agentes">
      <h2>Bloques y agentes</h2>
      <Field label="Bloques de comandos" setting="blocks.enabled" hint="Marca al costado de cada comando (roja si falló), menú para copiar o volver a ejecutar, Ctrl+↑ / Ctrl+↓ para saltar entre ellos. Requiere la integración de shell.">
        {(id) => <Toggle id={id} value={blocks.enabled} disabled={locked} onCommit={(v) => setSetting(['blocks', 'enabled'], v)} />}
      </Field>
      <h3>Agentes de IA</h3>
      <Field label="Detectar agentes" setting="agents.enabled" hint="claude, codex y gemini: indicador en la tab y en el panel, y el preset multi-agente.">
        {(id) => <Toggle id={id} value={agents.enabled} disabled={locked} onCommit={(v) => setSetting(['agents', 'enabled'], v)} />}
      </Field>
      <Field label="Espera tu respuesta tras" setting="agents.idleSeconds" hint="Segundos sin salida (si el agente no lo avisó antes con una campana o una notificación).">
        {(id) => <NumberInput id={id} value={agents.idleSeconds} min={2} max={600} disabled={locked} onCommit={(v) => setSetting(['agents', 'idleSeconds'], v)} />}
      </Field>
      {(Object.keys(AGENT_LABELS) as AgentName[]).map((name) => (
        <Field key={name} label={`Comando de ${AGENT_LABELS[name]}`} setting={`agents.commands.${name}`} hint={name === 'claude' ? 'Lo que el preset multi-agente escribe en cada panel (con argumentos, si querés).' : undefined}>
          {(id) => (
            <TextInput
              id={id}
              value={agents.commands[name]}
              disabled={locked}
              onCommit={(v) => v.trim() && setSetting(['agents', 'commands', name], v.trim())}
            />
          )}
        </Field>
      ))}
      <h3>Notificaciones</h3>
      <Field label="Notificaciones de Windows" setting="notifications.enabled" hint="Cuando un panel que no está a la vista pide atención (OSC 9, OSC 777, campana, agentes). Clic: Brisa al frente con ese panel.">
        {(id) => <Toggle id={id} value={notifications.enabled} disabled={locked} onCommit={(v) => setSetting(['notifications', 'enabled'], v)} />}
      </Field>
      <Field label="La campana avisa" setting="notifications.bell">
        {(id) => <Toggle id={id} value={notifications.bell} disabled={locked} onCommit={(v) => setSetting(['notifications', 'bell'], v)} />}
      </Field>
      <Field label="Agentes que esperan o terminan" setting="notifications.agents">
        {(id) => <Toggle id={id} value={notifications.agents} disabled={locked} onCommit={(v) => setSetting(['notifications', 'agents'], v)} />}
      </Field>
      <h3>Worktrees creados por Brisa</h3>
      <WorktreeList />
    </section>
  );
}
