// The multi-agent preset: a tab with 2 to 4 panes in the current folder, each running the agent
// chosen for it (typed once its shell is ready, like a layout's commands). Optionally each pane
// gets its own git worktree, so the agents do not step on each other's files; Brisa removes the
// worktrees it created when their pane closes, and asks first if one has uncommitted changes.
import type { NodeSpec, PaneSpec } from '../store/layoutModel';
import { useSettings } from '../store/settings';
import { useUi } from '../store/ui';
import { useWorkspace } from '../store/workspace';
import type { AgentName, PaneId, PaneWorktree } from '../store/workspaceModel';
import { worktreeCreate, worktreeRemove, worktreeStatus, type Worktree } from './fsApi';
import { queueInitialCommand } from './initialCommands';
import { focusActiveTerminal } from './tabActions';

/** What runs in each pane: an agent, or just the shell. */
export type PaneChoice = AgentName | 'shell';

export interface MultiAgentPlan {
  cwd: string | null;
  panes: PaneChoice[];
  worktrees: boolean;
}

/** 2: side by side; 3: one on the left, two stacked on the right; 4: a 2×2 grid. */
export function arrange(panes: PaneSpec[]): NodeSpec {
  const [a, b, c, d] = panes;
  if (!a || !b) return a ?? {};
  if (!c) return { split: 'horizontal', panes: [a, b] };
  if (!d) return { split: 'horizontal', panes: [a, { split: 'vertical', panes: [b, c] }] };
  return { split: 'vertical', panes: [{ split: 'horizontal', panes: [a, b] }, { split: 'horizontal', panes: [c, d] }] };
}

const toPaneWorktree = (w: Worktree): PaneWorktree => ({ path: w.path, repo: w.repo, branch: w.branch });

export async function openMultiAgent(plan: MultiAgentPlan): Promise<boolean> {
  const { commands } = useSettings.getState().settings.agents;
  const created: Worktree[] = [];
  if (plan.worktrees && plan.cwd) {
    try {
      for (const [i, choice] of plan.panes.entries()) created.push(await worktreeCreate(plan.cwd, `${choice}-${i + 1}`));
    } catch (error) {
      for (const w of created) await worktreeRemove(w.path, true).catch(() => {});
      useUi.getState().showToast(`No se pudieron crear los worktrees: ${String(error)}`, 'warning');
      return false;
    }
  }
  const specs: PaneSpec[] = plan.panes.map((choice, i) => {
    const worktree = created[i];
    const cwd = worktree?.path ?? plan.cwd ?? undefined;
    return {
      ...(cwd ? { cwd } : {}),
      ...(choice !== 'shell' ? { command: commands[choice] } : {}),
      ...(worktree ? { worktree: toPaneWorktree(worktree) } : {}),
    };
  });
  const agents = plan.panes.filter((p) => p !== 'shell');
  const title = agents.length ? `Agentes: ${[...new Set(agents)].join(', ')}` : 'Multi-panel';
  const result = useWorkspace.getState().openWindow({ tabs: [{ title, layout: arrange(specs) }], groups: [] });
  for (const { paneId, command } of result.commands) queueInitialCommand(paneId, command);
  focusActiveTerminal();
  return true;
}

// ---------------------------------------------------------------- cleanup

const inside = (dir: string | null, root: string) => {
  if (!dir) return false;
  const a = dir.toLowerCase().replace(/[\\/]+$/, '');
  const b = root.toLowerCase().replace(/[\\/]+$/, '');
  return a === b || a.startsWith(`${b}\\`);
};

const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

/** Tries a few times: the closed pane's processes may still hold files in the folder. */
async function removeSoon(path: string, force: boolean): Promise<boolean> {
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      await worktreeRemove(path, force);
      return true;
    } catch {
      await sleep(500);
    }
  }
  return false;
}

/**
 * The panes that owned these worktrees were closed: remove the clean ones; ask about the ones
 * with uncommitted changes. A worktree another pane still works in passes to that pane.
 */
export async function releaseWorktrees(worktrees: PaneWorktree[]): Promise<void> {
  const dirty: { worktree: PaneWorktree; changes: number }[] = [];
  const failed: string[] = [];
  for (const worktree of worktrees) {
    const ws = useWorkspace.getState();
    const heir = Object.values(ws.panes).find((p) => !p.worktree && (inside(p.cwd, worktree.path) || inside(p.startCwd, worktree.path)));
    if (heir) {
      ws.setPaneWorktree(heir.id, worktree);
      continue;
    }
    // Give the closed shell a moment to let go of the folder.
    await sleep(300);
    const status = await worktreeStatus(worktree.path).catch(() => null);
    if (status && status.exists && status.changes > 0) {
      dirty.push({ worktree, changes: status.changes });
      continue;
    }
    if (!(await removeSoon(worktree.path, false))) failed.push(worktree.path);
  }
  if (failed.length) {
    useUi.getState().showToast(`No se pudo borrar ${failed.length === 1 ? 'un worktree' : `${failed.length} worktrees`} (¿archivos en uso?). Quedan en Configuración → Bloques y agentes.`, 'warning');
  }
  if (dirty.length) {
    useUi.getState().openConfirm({
      title: dirty.length === 1 ? '¿Borrar el worktree con cambios?' : `¿Borrar ${dirty.length} worktrees con cambios?`,
      message: 'Tienen cambios sin commitear: si se borran, esos cambios se pierden. Conservados, quedan en Configuración → Bloques y agentes.',
      details: dirty.map(({ worktree, changes }) => `${worktree.path} (${changes === 1 ? '1 cambio' : `${changes} cambios`})`),
      confirmLabel: 'Borrar igual',
      cancelLabel: 'Conservar',
      target: { kind: 'worktrees', paths: dirty.map(({ worktree }) => worktree.path) },
    });
  }
}

/** "Borrar igual": removes them with their uncommitted changes. */
export async function forceRemoveWorktrees(paths: string[]): Promise<void> {
  let failed = 0;
  for (const path of paths) if (!(await removeSoon(path, true))) failed++;
  if (failed) useUi.getState().showToast(`No se pudo borrar ${failed === 1 ? 'un worktree' : `${failed} worktrees`}.`, 'warning');
}

/** Worktrees owned by these panes (before closing them). */
export function worktreesOf(paneIds: PaneId[]): PaneWorktree[] {
  const panes = useWorkspace.getState().panes;
  return paneIds.map((id) => panes[id]?.worktree).filter((w): w is PaneWorktree => !!w);
}
