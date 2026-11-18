import { useShallow } from 'zustand/react/shallow';
import { TAB_COLORS } from '../config/colors';
import { closeOtherTabs, focusActiveTerminal, groupTab, requestCloseTabs } from '../lib/tabActions';
import { useUi } from '../store/ui';
import { useWorkspace } from '../store/workspace';
import { tabsInGroup, type GroupId, type TabId } from '../store/workspaceModel';
import { ColorSwatches, Menu, MenuItem, MenuLabel, MenuSeparator } from './Menu';

const closeMenu = () => useUi.getState().closeMenu();
const dismiss = () => {
  closeMenu();
  focusActiveTerminal();
};
/** Closes the menu, then runs the action. */
const run = (action: () => void) => () => {
  closeMenu();
  action();
};

/** The open context menu (tab or group), if any. */
export function ContextMenus() {
  const menu = useUi((s) => s.menu);
  if (!menu) return null;
  return menu.kind === 'tab' ? (
    <TabMenu tabId={menu.tabId} x={menu.x} y={menu.y} />
  ) : (
    <GroupMenu groupId={menu.groupId} x={menu.x} y={menu.y} />
  );
}

function TabMenu({ tabId, x, y }: { tabId: TabId; x: number; y: number }) {
  const tab = useWorkspace((s) => s.tabs[tabId]);
  const groups = useWorkspace(useShallow((s) => Object.values(s.groups)));
  const tabCount = useWorkspace((s) => s.tabOrder.length);
  if (!tab) return null;
  const ws = useWorkspace.getState();
  const otherGroups = groups.filter((g) => g.id !== tab.groupId);

  return (
    <Menu x={x} y={y} label="Acciones de la tab" onClose={dismiss}>
      <MenuItem action="rename" shortcut="F2" onSelect={run(() => useUi.getState().startRenameTab(tabId))}>
        Renombrar
      </MenuItem>
      <MenuLabel>Color</MenuLabel>
      <ColorSwatches
        value={tab.color}
        allowNone
        onPick={(color) => {
          ws.setTabColor(tabId, color);
          dismiss();
        }}
      />
      <MenuItem action="duplicate" onSelect={run(() => {
          ws.duplicateTab(tabId);
          focusActiveTerminal();
        })}>
        Duplicar
      </MenuItem>
      <MenuSeparator />
      <MenuLabel>Mover a grupo</MenuLabel>
      <MenuItem action="new-group" shortcut="Ctrl+Shift+G" onSelect={run(() => groupTab(tabId))}>
        Nuevo grupo
      </MenuItem>
      {otherGroups.map((group) => (
        <MenuItem
          key={group.id}
          action="move-to-group"
          data-group-id={group.id}
          onSelect={run(() => {
            ws.moveTabToGroup(tabId, group.id);
            focusActiveTerminal();
          })}
        >
          <span className="menu-dot" style={{ background: TAB_COLORS[group.color] }} />
          {group.name || 'Grupo sin nombre'}
        </MenuItem>
      ))}
      {tab.groupId && (
        <MenuItem action="remove-from-group" onSelect={run(() => {
            ws.removeFromGroup(tabId);
            focusActiveTerminal();
          })}>
          Quitar del grupo
        </MenuItem>
      )}
      <MenuSeparator />
      <MenuItem action="close" shortcut="Ctrl+W" onSelect={run(() => void requestCloseTabs([tabId]))}>
        Cerrar
      </MenuItem>
      <MenuItem action="close-others" disabled={tabCount < 2} onSelect={run(() => void closeOtherTabs(tabId))}>
        Cerrar las demás
      </MenuItem>
    </Menu>
  );
}

function GroupMenu({ groupId, x, y }: { groupId: GroupId; x: number; y: number }) {
  const group = useWorkspace((s) => s.groups[groupId]);
  if (!group) return null;
  const ws = useWorkspace.getState();

  return (
    <Menu x={x} y={y} label="Acciones del grupo" onClose={dismiss}>
      <MenuItem action="rename-group" onSelect={run(() => useUi.getState().startRenameGroup(groupId))}>
        Renombrar grupo
      </MenuItem>
      <MenuLabel>Color</MenuLabel>
      <ColorSwatches
        value={group.color}
        onPick={(color) => {
          if (color) ws.setGroupColor(groupId, color);
          dismiss();
        }}
      />
      <MenuItem action="toggle-group" onSelect={run(() => {
          ws.toggleGroupCollapsed(groupId);
          focusActiveTerminal();
        })}>
        {group.collapsed ? 'Expandir' : 'Colapsar'}
      </MenuItem>
      <MenuItem action="ungroup" onSelect={run(() => {
          ws.ungroup(groupId);
          focusActiveTerminal();
        })}>
        Desagrupar
      </MenuItem>
      <MenuSeparator />
      <MenuItem action="close-group" onSelect={run(() => void requestCloseTabs(tabsInGroup(ws, groupId)))}>
        Cerrar grupo
      </MenuItem>
    </Menu>
  );
}
