import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { CSSProperties, MouseEvent } from 'react';
import { TAB_COLORS } from '../config/colors';
import { folderName } from '../lib/paths';
import { focusActiveTerminal, requestCloseTabs } from '../lib/tabActions';
import { useProfile } from '../store/profiles';
import { useUi } from '../store/ui';
import { useWorkspace } from '../store/workspace';
import { AGENT_LABELS } from '../lib/agentMonitor';
import { useSettings } from '../store/settings';
import { panesOf, tabIndicator, tabTitle, type AgentName, type TabId, type TabIndicator } from '../store/workspaceModel';
import { ProfileIcon } from './ProfileIcon';
import { RenameInput } from './RenameInput';

const INDICATOR_LABEL: Record<NonNullable<TabIndicator>, string> = {
  'agent-waiting': 'espera tu respuesta',
  'agent-working': 'trabajando',
  'agent-finished': 'terminó',
  activity: 'Salida nueva',
  exited: 'El proceso terminó',
  'exited-error': 'El proceso terminó con error',
};

export function TabItem({ tabId }: { tabId: TabId }) {
  const title = useWorkspace((s) => tabTitle(s, tabId));
  const agentsOn = useSettings((s) => s.settings.agents.enabled);
  const rawIndicator = useWorkspace((s) => tabIndicator(s, tabId));
  // With agents turned off their states do not show.
  const indicator = !agentsOn && rawIndicator?.startsWith('agent-') ? null : rawIndicator;
  // The agent the indicator talks about (the first one in the tab in that state).
  const agentName = useWorkspace((s): AgentName | null => {
    const tab = s.tabs[tabId];
    if (!tab || !indicator?.startsWith('agent-')) return null;
    const state = indicator.slice('agent-'.length);
    return panesOf(tab.layout).map((id) => s.panes[id]?.agent).find((a) => a?.state === state)?.name ?? null;
  });
  const active = useWorkspace((s) => s.activeTabId === tabId);
  const color = useWorkspace((s) => s.tabs[tabId]?.color ?? null);
  const group = useWorkspace((s) => {
    const groupId = s.tabs[tabId]?.groupId;
    return groupId ? s.groups[groupId] : undefined;
  });
  const exitCode = useWorkspace((s) => s.panes[s.tabs[tabId]?.activePaneId ?? '']?.exitCode ?? null);
  const customTitle = useWorkspace((s) => s.tabs[tabId]?.customTitle ?? null);
  const cwd = useWorkspace((s) => s.panes[s.tabs[tabId]?.activePaneId ?? '']?.cwd ?? null);
  const profileId = useWorkspace((s) => s.panes[s.tabs[tabId]?.activePaneId ?? '']?.profile ?? null);
  const profile = useProfile(profileId);
  const renaming = useUi((s) => s.renamingTabId === tabId);
  // The active pane's folder under the title, unless the user named the tab (or the title
  // already says it).
  const folder = cwd ? folderName(cwd) : null;
  const subtitle = !customTitle && folder && folder.toLowerCase() !== title.toLowerCase() ? folder : null;
  // Not `disabled: renaming`: dnd-kit would mark the tab (and its input) aria-disabled. While
  // renaming, the drag listeners are simply not attached.
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: tabId });

  const style: CSSProperties & Record<'--tab-color' | '--group-color', string> = {
    transform: CSS.Translate.toString(transform),
    transition,
    '--tab-color': color ? TAB_COLORS[color] : 'transparent',
    '--group-color': group ? TAB_COLORS[group.color] : 'transparent',
  };

  const activate = () => {
    useWorkspace.getState().activateTab(tabId);
    focusActiveTerminal();
  };
  const onContextMenu = (event: MouseEvent) => {
    event.preventDefault();
    useUi.getState().openMenu({ kind: 'tab', tabId, x: event.clientX, y: event.clientY });
  };
  const close = (event: MouseEvent) => {
    event.stopPropagation();
    void requestCloseTabs([tabId]);
  };
  const endRename = (apply?: () => void) => {
    apply?.();
    useUi.getState().stopRename();
    focusActiveTerminal();
  };

  const indicatorLabel = indicator
    ? agentName
      ? `${AGENT_LABELS[agentName]} ${INDICATOR_LABEL[indicator]}`
      : INDICATOR_LABEL[indicator]
    : undefined;
  let tooltip = title;
  if (indicator && agentName) tooltip += ` — ${indicatorLabel}`;
  else if (indicator && indicator !== 'activity') tooltip += ` — ${indicatorLabel}${exitCode !== null ? ` (código ${exitCode})` : ''}`;
  if (profile) tooltip += `\n${profile.name}`;
  if (cwd) tooltip += `\n${cwd}`;

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...(renaming ? {} : listeners)}
      role="tab"
      aria-selected={active}
      title={tooltip}
      className="tab"
      data-tab-id={tabId}
      data-active={active || undefined}
      data-dragging={isDragging || undefined}
      data-color={color ?? undefined}
      data-group-id={group?.id}
      data-indicator={indicator ?? undefined}
      onClick={activate}
      onDoubleClick={() => useUi.getState().startRenameTab(tabId)}
      onContextMenu={onContextMenu}
      onAuxClick={(event) => event.button === 1 && close(event)}
    >
      <ProfileIcon profile={profile} />
      {renaming ? (
        <RenameInput
          initial={customTitle ?? title}
          label="Nombre de la tab"
          // Blank goes back to following the process title.
          onCommit={(value) => endRename(() => useWorkspace.getState().renameTab(tabId, value))}
          onCancel={() => endRename()}
        />
      ) : (
        <span className="tab-text">
          <span className="tab-title">{title}</span>
          {subtitle && <span className="tab-subtitle">{subtitle}</span>}
        </span>
      )}
      <span className="tab-indicator" aria-label={indicatorLabel} data-agent={agentName ?? undefined} />
      <button
        type="button"
        className="tab-close"
        aria-label="Cerrar tab"
        title="Cerrar tab"
        onClick={close}
        onPointerDown={(event) => event.stopPropagation()}
      >
        ×
      </button>
    </div>
  );
}
