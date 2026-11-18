import { useShallow } from 'zustand/react/shallow';
import { focusActiveTerminal } from '../lib/tabActions';
import { useSettings } from '../store/settings';
import { useUi } from '../store/ui';
import { selectActivePaneId, useWorkspace } from '../store/workspace';
import { SearchBar } from './SearchBar';
import { TerminalPane } from './TerminalPane';

/**
 * Every pane of every tab stays mounted; only the active tab's pane is displayed. Panes are
 * rendered in creation order (not tab order) so reordering tabs never moves terminal DOM.
 */
export function Workspace() {
  const paneIds = useWorkspace(useShallow((s) => Object.keys(s.panes)));
  const activePaneId = useWorkspace(selectActivePaneId);
  const searchOpen = useUi((s) => s.searchOpen);
  const background = useSettings((s) => s.theme.background);

  const closeSearch = () => {
    useUi.getState().closeSearch();
    focusActiveTerminal();
  };

  return (
    <main className="workspace" style={{ background }}>
      {paneIds.map((id) => (
        <TerminalPane key={id} paneId={id} visible={id === activePaneId} />
      ))}
      {searchOpen && activePaneId && <SearchBar key={activePaneId} paneId={activePaneId} onClose={closeSearch} />}
    </main>
  );
}
