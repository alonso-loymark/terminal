import {
  closestCenter,
  DndContext,
  PointerSensor,
  pointerWithin,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
} from '@dnd-kit/core';
import { horizontalListSortingStrategy, SortableContext } from '@dnd-kit/sortable';
import { Fragment } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { focusActiveTerminal } from '../lib/tabActions';
import { useChrome } from '../store/chrome';
import { useShortcutLabel } from '../store/keymap';
import { useUi } from '../store/ui';
import { useWorkspace } from '../store/workspace';
import { visibleTabIds } from '../store/workspaceModel';
import { GroupChip } from './GroupChip';
import { TabItem } from './TabItem';
import { WindowControls } from './WindowControls';

const GROUP_PREFIX = 'group:';
const isGroupTarget = (id: unknown) => String(id).startsWith(GROUP_PREFIX);

/**
 * A group chip only catches a tab when the pointer is actually over it; otherwise the tab is
 * reordered relative to the closest tab, so reordering near a group never joins it by accident.
 */
const collisionDetection: CollisionDetection = (args) => {
  const chip = pointerWithin(args).find((collision) => isGroupTarget(collision.id));
  if (chip) return [chip];
  return closestCenter({
    ...args,
    droppableContainers: args.droppableContainers.filter((container) => !isGroupTarget(container.id)),
  });
};

/**
 * The tabs. With the custom title bar (the default) this is the window's title bar too: its
 * empty space drags the window (double click maximizes) and the caption buttons sit at the right.
 */
export function TabBar() {
  const custom = !useChrome((s) => s.nativeTitleBar);
  // Tauri's drag region: only clicks on these elements themselves (not on tabs or buttons).
  const drag = custom ? { 'data-tauri-drag-region': '' } : {};
  const tabOrder = useWorkspace((s) => s.tabOrder);
  // The strip: a group chip before the first tab of each group, then the visible tabs.
  const segments = useWorkspace(
    useShallow((s) => {
      const visible = new Set(visibleTabIds(s));
      const out: string[] = [];
      let lastGroup: string | null = null;
      for (const id of s.tabOrder) {
        const groupId = s.tabs[id]?.groupId ?? null;
        if (groupId && groupId !== lastGroup) out.push(`${GROUP_PREFIX}${groupId}`);
        lastGroup = groupId;
        if (visible.has(id)) out.push(id);
      }
      return out;
    }),
  );
  const sortable = segments.filter((id) => !isGroupTarget(id));
  const newTabKey = useShortcutLabel('tab.new');
  // Keep clicks and double-clicks working: a drag starts after moving 6 px.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over) return;
    const ws = useWorkspace.getState();
    const id = String(active.id);
    const overId = String(over.id);
    if (isGroupTarget(overId)) ws.moveTabToGroup(id, overId.slice(GROUP_PREFIX.length));
    else ws.moveTab(id, overId);
    focusActiveTerminal();
  };

  return (
    <nav className="tab-bar" aria-label="Tabs" data-title-bar={custom || undefined} {...drag}>
      <div className="tab-strip" role="tablist" data-tab-count={tabOrder.length} {...drag}>
        <DndContext sensors={sensors} collisionDetection={collisionDetection} onDragEnd={onDragEnd}>
          <SortableContext items={sortable} strategy={horizontalListSortingStrategy}>
            {segments.map((id) => (
              <Fragment key={id}>
                {isGroupTarget(id) ? <GroupChip groupId={id.slice(GROUP_PREFIX.length)} /> : <TabItem tabId={id} />}
              </Fragment>
            ))}
          </SortableContext>
        </DndContext>
      </div>
      <button
        type="button"
        className="tab-new"
        title={newTabKey ? `Nueva tab (${newTabKey})` : 'Nueva tab'}
        aria-label="Nueva tab"
        onClick={() => {
          useWorkspace.getState().newTab();
          focusActiveTerminal();
        }}
      >
        +
      </button>
      <button
        type="button"
        className="tab-new-menu"
        title="Nueva tab con otro perfil, layouts"
        aria-label="Elegir perfil para la nueva tab"
        aria-haspopup="menu"
        onClick={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          useUi.getState().openMenu({ kind: 'shells', x: box.left, y: box.bottom });
        }}
      >
        ▾
      </button>
      <div className="tab-bar-space" {...drag} />
      {custom && <WindowControls />}
    </nav>
  );
}
