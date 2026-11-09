# Approval suppression (MCP-only)

Interactive DSH approval prompts (`approval/request` on the agent's own scope) block MCP-driven
tasks: this plugin's sessions are non-interactive workers, so a prompt has no answerer to wait for.

## Behavior

The plugin registers one `approval/request` waterfall listener on its own plugin context. Cordis
dispatches that event with the request agent as the scope target, so only requests for agents inside
this plugin's scope — the sessions this plugin created — reach the listener.

| Request belongs to | Outcome |
| --- | --- |
| an agent this plugin owns (present in its own `liveAgents` / `sessionToCwd` maps) | decided here, deterministically, never interactively: `rejected` by default, `allowed-once` only on an allowlist match |
| any other agent (browser-owned, including sessions merely taken over via `ctx.agents.get`) | `next()` unchanged — the web UI keeps its interactive `ask` behavior |

Default config leaves the allowlist empty, so nothing is auto-approved. The fail-closed default is
the non-interactive worker contract: a plugin-owned prompt is answered `rejected` without waiting.

## Matching fields

The approval request payload carries the agent identity (`agent.id`), `toolName`, and optional
`callId` / `reason` / `displayReason` / `signal`. It carries **no command or path fields**, so the
allowlist can only match on:

- the agent identity, resolved through the plugin's own maps to the session's canonicalized cwd,
  compared against the configured `root` (same `resolve` prefix comparison as `workspaceRoots`);
- `toolName`, matched exactly.

An entry whose `root` and `toolName` are both omitted grants every request of a plugin-owned session.

## Config

```yaml
config:
  approvalAllowlist:                       # optional; empty default = every plugin-owned request is rejected
    - root: /path/to/workspace             # optional: workspace root prefix for the session cwd
      toolName: bash                       # optional: exact request toolName
```

## Not changed

Sandbox settings, permission presets, approval policy defaults, CLI behavior, shell escalation
checks, and every other approval path. Sessions this plugin resumed from persistence are not in the
ownership maps, so they keep the passthrough path.

## Verification

`node smoke.mjs` (dev-only fake-ctx harness): 17 checks, 13 baseline + 4 approval checks —
plugin-owned + empty allowlist → `rejected` without the UI chain being consulted; non-owned →
delegates to `next()` and passes its outcome through; allowlist match → `allowed-once`;
non-matching `toolName` → still `rejected`. The same harness also ran against `src/index.ts`
directly (tsx) with identical results.
