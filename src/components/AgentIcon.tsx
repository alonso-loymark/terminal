import { Asterisk, Orbit, Sparkle, SquareCode, type LucideIcon } from 'lucide-react';
import type { AgentName } from '../store/workspaceModel';

/** One plain glyph per agent (no logos): Claude's asterisk, Gemini's sparkle, code, an orbit. */
const ICONS: Record<AgentName, LucideIcon> = {
  claude: Asterisk,
  codex: SquareCode,
  gemini: Sparkle,
  agy: Orbit,
};

/** The icon of the AI agent running in a pane (instead of its shell's, while it runs). */
export function AgentIcon({ agent }: { agent: AgentName }) {
  const Icon = ICONS[agent];
  return <Icon className="profile-icon agent-icon" data-agent={agent} aria-hidden="true" />;
}
