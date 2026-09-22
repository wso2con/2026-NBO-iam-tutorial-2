/**
 * Friendly display names for the AI agents that book on a user's behalf.
 *
 * The agent's identity arrives as the OBO access token's `act.sub` claim, which
 * is an opaque Asgardeo agent ID. Mapping it to a name is purely presentational,
 * so it is configured through the environment rather than stored in Asgardeo:
 *
 *   AGENT_DISPLAY_NAMES  "<agentId>=<Name>,<agentId>=<Name>"  (multi-agent map)
 *   AGENT_DISPLAY_NAME   "<Name>"                             (single-agent fallback)
 *
 * Server-side only — neither variable is NEXT_PUBLIC_, so agent IDs never reach
 * the browser bundle. This module is deliberately dependency-free (no DB, no
 * next/*) so the MCP server can import it statically the same way it imports
 * ../webapp/app/lib/auth/utils.js.
 */

/** Parses a comma-separated `<agentId>=<value>` map, skipping malformed entries. */
function parseAgentMap(raw: string | undefined): Map<string, string> {
  const map = new Map<string, string>();

  for (const entry of (raw ?? "").split(",")) {
    const separatorIndex = entry.indexOf("=");
    if (separatorIndex <= 0) continue;

    const agentId = entry.slice(0, separatorIndex).trim();
    const name = entry.slice(separatorIndex + 1).trim();

    if (agentId && name) map.set(agentId, name);
  }

  return map;
}

let _displayNames: Map<string, string> | null = null;

// Parsed once, but on first use rather than at module load: mcp/server.ts imports
// this module statically, and static imports are evaluated before its
// loadEnvFile() calls populate process.env.
function getDisplayNames(): Map<string, string> {
  if (!_displayNames) _displayNames = parseAgentMap(process.env.AGENT_DISPLAY_NAMES);
  return _displayNames;
}

/**
 * Resolves an agent ID to its configured display name, or null when nothing
 * matches — the UI then falls back to showing the raw ID rather than a guess.
 */
export function resolveAgentName(agentId: string | null): string | null {
  const id = agentId?.trim();
  if (!id) return null;

  const mapped = getDisplayNames().get(id);
  if (mapped) return mapped;

  return process.env.AGENT_DISPLAY_NAME?.trim() || null;
}

/**
 * Badge accents the bookings UI knows how to render. Values outside this list are
 * ignored rather than trusted, since the value ends up in a CSS class name.
 */
const AGENT_ACCENTS = ["violet", "green"] as const;

export type AgentAccent = (typeof AGENT_ACCENTS)[number];

function isAgentAccent(value: string): value is AgentAccent {
  return (AGENT_ACCENTS as readonly string[]).includes(value);
}

let _accents: Map<string, AgentAccent> | null = null;

function getAccents(): Map<string, AgentAccent> {
  if (!_accents) {
    _accents = new Map();

    for (const [agentId, value] of parseAgentMap(process.env.AGENT_DISPLAY_ACCENTS)) {
      const accent = value.toLowerCase();
      if (isAgentAccent(accent)) _accents.set(agentId, accent);
    }
  }

  return _accents;
}

/**
 * Resolves an agent ID to its configured badge accent, or null to leave the badge
 * in the default accent. Unlike the display name this is resolved when bookings are
 * read, so recolouring an agent needs no change to already-stored rows.
 */
export function resolveAgentAccent(agentId: string | null): AgentAccent | null {
  const id = agentId?.trim();
  if (!id) return null;

  return getAccents().get(id) ?? null;
}
