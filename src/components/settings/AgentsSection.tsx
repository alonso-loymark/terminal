// Command blocks, AI agents, the orchestrator, notifications and the worktrees Brisa created
// (settings screen).
import { useCallback, useEffect, useState } from 'react';
import { AGENT_LABELS } from '../../lib/agentMonitor';
import { worktreeList, worktreeRemove, worktreeStatus, type Worktree, type WorktreeStatus } from '../../lib/fsApi';
import { setSetting } from '../../lib/settingsSync';
import { AI_MODELS, commandPatternIssue } from '../../config/settingsSchema';
import { useOrchestrator } from '../../store/orchestrator';
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

/** The orchestrator mode (Fase 8A). */
function OrchestratorSettings({ locked }: { locked: boolean }) {
  const orchestrator = useSettings((s) => s.settings.orchestrator);
  // The stored array itself (a `?? []` in the selector would be a new value on every render).
  const models = useOrchestrator((s) => s.agents?.find((a) => a.id === 'claude')?.models);
  const suggestions = models?.length ? models.filter((m) => m.value !== 'default').map((m) => m.value) : [...AI_MODELS];
  return (
    <>
      <h3>Orquestador</h3>
      <Field
        label="Modo orquestador"
        setting="orchestrator.enabled"
        hint="Tabs «Orquestador» (paleta, o la flecha junto al «+» → Abrir orquestador aquí): un chat por proyecto que decide agente, modelo y esfuerzo y ejecuta cada tarea con Claude Code en la carpeta del proyecto. Apagado, no se lanza nada."
      >
        {(id) => <Toggle id={id} value={orchestrator.enabled} disabled={locked} onCommit={(v) => setSetting(['orchestrator', 'enabled'], v)} />}
      </Field>
      <Field label="Modelo principal" setting="orchestrator.mainModel" hint="El que arma el plan de cada mensaje (sonnet = costo medio). Cada proyecto puede elegir otro en su selector. Los modelos salen de Claude Code.">
        {(id) => (
          <TextInput
            id={id}
            value={orchestrator.mainModel}
            suggestions={suggestions}
            disabled={locked}
            onCommit={(v) => v.trim() && setSetting(['orchestrator', 'mainModel'], v.trim())}
          />
        )}
      </Field>
      <Field label="Ejecutar sin aprobar" setting="orchestrator.autoApprove" hint="El plan se muestra igual, pero se ejecuta sin esperar «Aprobar».">
        {(id) => <Toggle id={id} value={orchestrator.autoApprove} disabled={locked} onCommit={(v) => setSetting(['orchestrator', 'autoApprove'], v)} />}
      </Field>
      <Field
        label="Comandos permitidos"
        setting="orchestrator.allowedCommands"
        hint="Uno por línea, * = cualquier texto (npm run e2e *). Se suman a los que Brisa detecta en cada proyecto (build, tests, lint) y a git en solo lectura. Todo lo demás se deniega y se te pregunta."
      >
        {(id) => (
          <TextInput
            id={id}
            multiline
            value={orchestrator.allowedCommands.join('\n')}
            disabled={locked}
            onCommit={(v) => {
              const list = [...new Set(v.split(/\r?\n/).map((l) => l.trim()).filter(Boolean))];
              const bad = list.map((l) => [l, commandPatternIssue(l)] as const).find(([, issue]) => issue);
              if (bad) {
                useUi.getState().showToast(`«${bad[0]}»: ${bad[1]}`, 'warning');
                return;
              }
              setSetting(['orchestrator', 'allowedCommands'], list);
            }}
          />
        )}
      </Field>
      <Field label="Máximo de turnos por tarea" setting="orchestrator.maxTurns">
        {(id) => <NumberInput id={id} value={orchestrator.maxTurns} min={5} max={400} disabled={locked} onCommit={(v) => setSetting(['orchestrator', 'maxTurns'], v)} />}
      </Field>
    </>
  );
}

export function AgentsSection() {
  const blocks = useSettings((s) => s.settings.blocks);
  const agents = useSettings((s) => s.settings.agents);
  const notifications = useSettings((s) => s.settings.notifications);
  const locked = useLocked();
  return (
    <section className="settings-section" aria-label="Agentes y orquestador">
      <h2>Bloques, agentes y orquestador</h2>
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
      {(Object.keys(agents.commands) as (keyof typeof agents.commands & AgentName)[]).map((name) => (
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
      <OrchestratorSettings locked={locked} />
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
