import { AGENT_LABELS } from '../lib/agentMonitor';
import { useSettings } from '../store/settings';
import { useWorkspace } from '../store/workspace';
import type { AgentState, PaneId } from '../store/workspaceModel';
import { AgentIcon } from './AgentIcon';

export const AGENT_STATE_LABELS: Record<AgentState, string> = {
  working: 'trabajando',
  waiting: 'espera tu respuesta',
  finished: 'terminó',
};

/** Top right of a pane running an AI agent: which one and what it is doing. */
export function AgentBadge({ paneId }: { paneId: PaneId }) {
  const agent = useWorkspace((s) => s.panes[paneId]?.agent ?? null);
  const enabled = useSettings((s) => s.settings.agents.enabled);
  if (!agent || !enabled) return null;
  return (
    <div className="agent-badge" data-agent={agent.name} data-state={agent.state} role="status">
      <AgentIcon agent={agent.name} />
      <span className="agent-dot" aria-hidden="true" />
      {AGENT_LABELS[agent.name]} · {AGENT_STATE_LABELS[agent.state]}
    </div>
  );
}
