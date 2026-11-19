import { useMemo, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { focusActiveTerminal } from '../lib/tabActions';
import { useUi } from '../store/ui';
import { selectActivePaneId, useWorkspace } from '../store/workspace';
import { layoutDividers, layoutRects, panesOf, type PaneId, type Rect, type Tab, type TabId } from '../store/workspaceModel';
import { PaneDivider } from './PaneDivider';
import { SearchBar } from './SearchBar';
import { TerminalPane } from './TerminalPane';

interface PanePlacement {
  rect: Rect;
  visible: boolean;
  focused: boolean;
}

const FULL: Rect = { x: 0, y: 0, w: 1, h: 1 };
const HIDDEN: PanePlacement = { rect: FULL, visible: false, focused: false };

/** Where each pane goes and whether it is on screen (only the active tab's, minus zoomed-out ones). */
function placePanes(tabs: Record<TabId, Tab>, activeTabId: TabId | null): Record<PaneId, PanePlacement> {
  const out: Record<PaneId, PanePlacement> = {};
  for (const tab of Object.values(tabs)) {
    const rects = layoutRects(tab.layout);
    const panes = panesOf(tab.layout);
    const active = tab.id === activeTabId;
    for (const id of panes) {
      const zoomed = tab.zoomedPaneId === id;
      out[id] = {
        rect: zoomed ? FULL : (rects[id] ?? FULL),
        visible: active && (!tab.zoomedPaneId || zoomed),
        focused: active && panes.length > 1 && !tab.zoomedPaneId && tab.activePaneId === id,
      };
    }
  }
  return out;
}

/**
 * Every pane of every tab stays mounted, in creation order and flat: the layout tree only
 * decides each pane's rectangle, so splitting, closing, dragging dividers or switching tabs
 * never rebuilds a terminal.
 */
export function Workspace() {
  const areaRef = useRef<HTMLDivElement>(null);
  const tabs = useWorkspace((s) => s.tabs);
  const activeTabId = useWorkspace((s) => s.activeTabId);
  const paneIds = useWorkspace(useShallow((s) => Object.keys(s.panes)));
  const activePaneId = useWorkspace(selectActivePaneId);
  const searchOpen = useUi((s) => s.searchOpen);

  const placement = useMemo(() => placePanes(tabs, activeTabId), [tabs, activeTabId]);
  const activeTab = activeTabId ? tabs[activeTabId] : undefined;
  const dividers = useMemo(
    () => (activeTab && !activeTab.zoomedPaneId ? layoutDividers(activeTab.layout) : []),
    [activeTab],
  );

  const closeSearch = () => {
    useUi.getState().closeSearch();
    focusActiveTerminal();
  };

  return (
    <main className="workspace">
      <div ref={areaRef} className="pane-area">
        {paneIds.map((id) => {
          const place = placement[id] ?? HIDDEN;
          return <TerminalPane key={id} paneId={id} visible={place.visible} focused={place.focused} rect={place.rect} />;
        })}
        {dividers.map((divider) => (
          <PaneDivider key={`${divider.splitId}:${divider.index}`} divider={divider} area={areaRef} />
        ))}
      </div>
      {searchOpen && activePaneId && <SearchBar key={activePaneId} paneId={activePaneId} onClose={closeSearch} />}
    </main>
  );
}
