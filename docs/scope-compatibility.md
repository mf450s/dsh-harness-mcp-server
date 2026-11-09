# Scope compatibility

## Failure mode

The plugin used to call `scopeOf(agentCtx)` before mounting the configured agent preset.

`dsh-scope` stores the scope marker on a context with a private JavaScript `Symbol`.
Two separately loaded copies of the package create two different symbols, even when the package names and versions are identical.

This occurs easily when the MCP plugin is installed in an external profile while the Harness agent runtime is loaded from another installation:

```text
agent-loop instance       -> creates agentCtx with scope symbol A
plugin instance           -> checks agentCtx with scope symbol B
scopeOf(agentCtx)         -> undefined
```

The old guard treated that false negative as an old dsh runtime bug and returned before mounting the preset. The session then started without the standard Coding tools. MCP transport and session creation still appeared healthy, which made the failure easy to miss.

## Fix in this fork

The plugin no longer performs its own `scopeOf` check.

Both the new-session and resume-session setup paths call the official runtime API directly:

```ts
await ctx.agentPresets.mount(agentCtx, runtimeConfig.preset)
```

`agentPresets.mount` is the authoritative scope boundary. It uses the same runtime service and scope implementation that created the agent context:

- a valid context mounts the requested preset;
- a genuinely unscoped context still fails loudly;
- no invalid context is silently downgraded to an agent without tools;
- the plugin no longer creates or imports a competing scope check.

This is not warning suppression. It removes a false-negative preflight check and delegates validation to the API that owns preset composition.

## Host requirement

The host must still load the dsh core runtime from one module graph.

A plugin-only change cannot make `dsh-agent-loop` from one installation compatible with `dsh-agent-presets` from another installation. A dsh monorepo normally provides one workspace instance. External profiles must deduplicate or link the dsh core packages to the same runtime instance.

If the host violates that requirement, the direct `agentPresets.mount` call now exposes the real error instead of hiding it:

```text
agent-presets: refusing to compose an unscoped context
```

## Verification

The fork was verified with a unified dsh core runtime:

- MCP service initialized successfully.
- `agent_run` mounted the configured preset.
- The Harness agent received and used the `bash` tool.
- The agent wrote a marker file inside the selected Git worktree.
- The parent process read the exact marker content and removed the file again.
- The worktree returned to its previous state apart from the intended source changes.
- The repository smoke test passed.

No credentials or host-specific configuration are part of the change.
