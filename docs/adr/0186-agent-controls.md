# 0186. Agent controls: one object per agent, presets and a resolver

- Status: Accepted (foundation built: the controls, their stock values, the `steady` preset, the validator, the
  resolver and the record on a run's first `context` step; no behaviour reads a control yet)
- Date: 2026-11-25
- Code: `packages/engine/src/lslf-controls.ts` (`LslfAgentControls`, `LslfWorkspaceControls`, `STOCK_*`, `STEADY_*`,
  `lslfControls`, `resolveAgentControls`, `resolveWorkspaceControls`, `lslfServerSettings`, `runControls`),
  `autonomy-settings.ts` (`chosenAutonomy` keeps `lslf`), `executor.ts` (resolved once, recorded on the run's first
  `context` step), `packages/config/src/schema.ts` (`LSLF_CONTROLS_PRESET`, `LSLF_CONTROLS_ORGS`,
  `LSLF_WORKSPACE_SET`); tests `packages/engine/test/lslf-controls.test.ts`, `packages/config/src/index.test.ts`

## Context

The server does much on an agent's behalf that the agent didn't ask for: it judges and nudges a finished turn, adds
blocks to the prompt, clips and drops history, moves work to the background, wakes the agent with notices, learns and
summarizes on its own. Each is reasonable alone; together they make the conditions an agent works in change from step
to step. An operator who wants agents to rely on the same conditions at every turn needs a way to narrow these, one
ability at a time, per agent, without a new database column (a server must be able to go back to an image without
this change on the same migrations).

## Decision

1. **One object per agent.** An agent's controls live in its existing `autonomy_brakes` JSON as
   `lslf = { preset?: "stock" | "steady", set?: { <key>: <value> } }`. `lslfControls(raw)` is its validator: an
   unknown preset or key is dropped, and so is a value of the wrong kind or out of range (refused, never clamped), so
   that key follows the layer below. `chosenAutonomy` keeps the normalized object when the brakes are saved; an empty
   one, or `null`, is left out. An image without this change reads only the brakes' own fields, so it ignores `lslf`.
2. **Workspace-scope controls are env vars.** Work that is a workspace's and not one agent's (shared memory upkeep,
   summaries, thread assessment, Vault sync) can't be governed by an agent's switch. Those controls are
   `LSLF_WORKSPACE_SET` (`key=on|off` pairs) over `LSLF_CONTROLS_PRESET`, resolved where the job is queued and where it
   runs. There is no free-form workspace settings column to hold them without a migration.
3. **Resolution, most specific first:** the agent's `set` → the agent's `preset` → `LSLF_CONTROLS_PRESET` → stock.
   `LSLF_CONTROLS_ORGS`, when set, limits the server's preset and workspace set to the workspaces it names; an agent's
   own preset or setting applies wherever the agent is. Nudges merge kind by kind.
4. **Resolved once per run.** The executor resolves an agent's controls when a run starts and records them, with the
   preset and where it came from, on the run's first `context` step (`lslf`). Every later turn of that run reads them
   from there (`runControls`), so a change made while it runs never reaches it, and every run says which controls it
   ran under.
5. **Stock by default.** Every control's stock value is today's behaviour. A `null` number or switch follows the
   server's own setting (`AGENT_CONTEXT_MESSAGES`, the burst wait, the background move).
6. **`steady` is data.** A preset is a full set of values, frozen, each of which passes the validator.
7. **Safeguards are not controls.** Permission and run-policy checks, approval cards, budgets, the secret check at a
   turn's end, work follow-up delivery and a wait detaching on a new message have no key, and the validator drops any
   key it doesn't know. The secret check is not one of the nudge kinds.
8. **Wired one at a time.** This change reads no control anywhere: with nothing set, and with `steady` set, runs behave
   exactly as before (a test compares prompts, replies, steps and jobs). Each control is wired by its own later change,
   with its own tests, and only then does a preset's value for it take effect.

## Consequences

- No migration; going back to an image without this change loses nothing but the controls' effect.
- Existing settings that a preset might also set (an agent's wake controls, media replies, skill improvement) are not
  part of `steady` here: changing them is a behaviour change and belongs with the change that decides it.
- A run's first `context` step is a little larger (the resolved controls).
- Workspace-scope controls are per server, not per workspace screen, until a workspace setting can hold them.
