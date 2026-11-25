export interface PermissionRule {
  readonly action: string;
  readonly resource: string;
  readonly effect: "allow" | "deny" | "ask";
}

/** Shell patterns every worker session denies. OpenCode anchors them, `*` matches anything. */
export const SHELL_DENY = [
  "*git *push*",
  "*git *merge*",
  "*git *commit*",
  "*git *config*",
  "*--no-verify*",
  "*opencode api*",
  "*/api/rpc/*",
  "*runtime.sock*",
  "*state.db*",
] as const;

export interface PermissionInput {
  readonly projectDeny: readonly string[];
  readonly mcpServers: readonly string[];
  readonly mcpRead: readonly string[];
}

/**
 * Session rules are evaluated after agent and config rules and the last match wins,
 * so allows for MCP reads must come after the per-server denies.
 */
export function buildSessionPermissions(input: PermissionInput): PermissionRule[] {
  const shell = [...SHELL_DENY, ...input.projectDeny].map((resource) => deny("shell", resource));
  const mcpDeny = input.mcpServers.map((server) => deny(`${server}_*`, "*"));
  const mcpAllow = input.mcpRead.map((tool): PermissionRule => ({
    action: tool,
    resource: "*",
    effect: "allow",
  }));

  return [
    ...shell,
    deny("edit", "opencode.json"),
    deny("edit", "opencode.jsonc"),
    deny("edit", ".opencode/*"),
    deny("external_directory", "*"),
    ...mcpDeny,
    ...mcpAllow,
  ];
}

function deny(action: string, resource: string): PermissionRule {
  return { action, resource, effect: "deny" };
}
