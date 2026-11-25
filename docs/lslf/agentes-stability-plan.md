# Agentes stability plan: switches that limit Agentes' involvement

LSLF fork only (issue #11). Brainstorm document: no code changes ride with it. The plan is revised in turns:

| Turn | Who         | Where                               |
| ---- | ----------- | ----------------------------------- |
| 1    | Claude Code | this file (first commit)            |
| 2    | Codex       | review comments on the pull request |
| 3    | Claude Code | a new commit to this file           |
| 4    | Codex       | review comments on the pull request |
| 5    | Claude Code | a new commit: one consolidated plan |

After turn 5, Claude Code drafts the code and tests on a separate branch, Codex reviews the tests, and LJ merges.

**LJ's goal:** "Switches and other controls used to limit or eliminate agentes involvement in so many functions. I need
to create a stable environment for the agents to rely on at each step and every turn."

**Labels.** **Fact** means checked in this fork's code (base v0.1.2). **Inference** means not checked yet.

---

## Turn 1 (Claude Code): one switch or control per issue

### The shape of every switch

**Fact (AGENTS.md rule 4):** migrations cannot change, so a switch cannot be a new database column. Each switch below
is an **env var** in `packages/config/src/schema.ts`, the only place env vars go (then `bun run docs:env`).

Where a switch should cover only some agents, its value is a list of handles, e.g.
`LSLF_STEADY_AGENTS=claudevcoo,dato`. One master switch, `LSLF_STEADY_MODE=on`, turns on every default below for the
agents in that list. Agents not listed keep stock Agentes behaviour, and LJ can switch back to the official image.

### 1. The fixed 20-minute call limit

- **Fact:** `ENDPOINT_CALL_TIMEOUT_MS = 20 * 60_000` and `ENDPOINT_REPLY_MAX_BYTES = 32_000_000` are constants in
  `packages/providers/src/custom.ts:95-96`. `boundedFetch` applies them to every exchange, including the time the
  reply body streams.
- **Switch:** `CUSTOM_ENDPOINT_TIMEOUT_MIN`. Default `20`, so nothing changes. Range 1–240, plus `0` for "no limit of
  our own; the proxy decides".
- **Takes away from Agentes:** when a long call gets cut off. The proxy owns its own timeouts.
- **Risk:** with `0`, a hung endpoint holds a worker. That is why a ceiling (say 4 h) is safer than a true infinity.

### 2. Automatic background move, `post_update` nudges, the ~10-minute timers

- **Fact:** the auto-move is `autoMove` in `packages/engine/src/executor.ts:4226`, ticking every 5 s. It reads
  `deps.workAutoAfterMs ?? WORK_AUTO_AFTER_MS` (4 min) and `deps.workAutoAfterCalls ?? WORK_AUTO_AFTER_CALLS` (20).
  Those `deps` hooks exist but are never set from config.
- **Fact:** the check-in and fallback jobs are `WORK_CHECK_IN_JOB` and `WORK_FOLLOW_UP_JOB` in `works.ts`. The tools
  come from `createWorkToolSource` in `apps/server/src/engine.ts:438`.
- **Switches, in three levels:**
  - (a) `AGENT_WORK_AUTO_MOVE=off`, default `on`. This is what open PR #10 does. It sets
    `deps.workAutoAfterMs = Infinity`, so `autoTick` never starts.
  - (b) `AGENT_WORK_TOOLS=off`. `work_in_background`, `post_update`, `steer_work` and `stop_work` are not offered to
    the listed agents, so they cannot move themselves either.
  - (c) With (b) on, no check-in or fallback jobs are queued. The server never posts "next update in ~10 min" for
    them.
- **Takes away from Agentes:** moving work into threads, update deadlines, and the server writing updates in the
  agent's name.
- **The stuck background task (still "running" after an hour):** a separate need. A work's "running" status should
  depend on its run being alive (a heartbeat or lease), and a dead work should not take new instructions.
  **Inference:** why it stayed "running" is not traced yet; it needs a test that recreates it.

### 3. The conversation window

- **Fact:** `AGENT_CONTEXT_MESSAGES` already exists (`packages/config/src/schema.ts:430`, default 30, max 500). It
  feeds `maxMessages` in `packages/engine/src/context.ts:704-744`. The thread is read first, then channel messages
  fill what is left. When older messages were dropped, the start moves to an "anchor", which is why about 24 show
  rather than 30.
- **Fact:** older messages are shortened by `cutOld` (`context.ts:2386-2394`). Every message except the last
  `KEEP_WHOLE = 8` that is over `LONG_OLD_MESSAGE = 1500` characters becomes its first 600 characters plus
  "expand <id> reopens it". This happens only when the `expand` tool is offered (`cutOld: options.expand === true`,
  `context.ts:1290`).
- **Switches:**
  - (a) Raise `AGENT_CONTEXT_MESSAGES`, e.g. to `100`. No code needed.
  - (b) New `AGENT_CUT_OLD_MESSAGES=off`, default `on`. The listed agents get every message in the window whole.
  - (c) New `AGENT_HISTORY_ANCHOR=off`. Uses exactly N messages, not N minus the anchor slack.
- **Takes away from Agentes:** the choice of what to drop or shorten within the window.
- **"First file block not closed":** **Fact:** that text is not in this repo, so the message comes from the proxy or
  DATO's side. **Inference:** the 48,000-character message was probably cut by one of the caps under issue 4, or it
  was old enough for `cutOld`. The run's `context` step would show which; trace it before choosing a fix.
- **Proxy as the source of truth:** send stable ids on every custom-endpoint call, using the existing `withHeaders`
  (`custom.ts:172`): `X-Agentes-Org`, `X-Agentes-Channel`, `X-Agentes-Thread`, `X-Agentes-Run`, `X-Agentes-Agent`, and
  the ids of every file in the conversation, not only those in the window. The proxy can then fetch whole history and
  files itself, through the API with its own token, and stop depending on what the window sends. Switch:
  `CUSTOM_ENDPOINT_CONTEXT_HEADERS=on`, default `off`.

### 4. Shortened reads (40,000 characters)

- **Fact:** these caps are hard-coded (paths under `packages/engine/src/`):

  | Place                   | Constant                                                                         | Value  |
  | ----------------------- | -------------------------------------------------------------------------------- | ------ |
  | `artifact-tools.ts:27`  | `MAX_READ_CHARS`                                                                 | 40,000 |
  | `artifacts.ts:253`      | `fileTextChars`                                                                  | 40,000 |
  | `sandbox.ts:38`         | `fileReadChars`                                                                  | 40,000 |
  | `skills.ts:36`          | `fileReadChars`                                                                  | 40,000 |
  | `tools/gateway.ts:318`  | `MAX_RESULT_CHARS` (marks `[truncated]`)                                         | 50,000 |
  | `context/tools.ts:1027` | `CONVERSATION_MESSAGE_CHARS` (one message read back through conversation search) | 1,500  |
  | `browser/tools.ts:368`  | `MAX_PAGE_TEXT`                                                                  | 40,000 |

- **Switch:** one env var, `AGENT_READ_MAX_CHARS`. Default 40,000, so nothing changes. Range up to about 400,000.
  Each cap above reads it; `MAX_RESULT_CHARS` becomes the larger of it and 50,000.
- **Plus:** paged reads (`offset`/`limit` lines) on `read_artifact` and the message read, so an 879-line file reads in
  pieces even under a cap.
- **Takes away from Agentes:** silent truncation. The agent decides how much to read.
- **Risk:** cost and context size per call. The budget checks stay (AGENTS.md rule 6).

### 5. Agent-to-agent wake blocked from background work

- **Fact:** `canTalkTo` (`packages/engine/src/audience.ts`, about line 195) returns `false` when `userId` is null and
  `audienceMode` is `"owner"`. A background run with nobody behind it is `NO_PERSON`. The refusal text comes from
  `unreachableWhy` (`continuation.ts:856`).
- **No-code option:** set both agents' audience to `people` with LJ named. This does not fix the null-person case,
  because the run has no requester.
- **Switch:** `AGENT_SAME_OWNER_WAKE=on`, default `off`. An agent's mention or hand-off may wake another agent with the
  same `ownerUserId`, acting as that owner. The permission check is still `canTalkTo`; the owner is the speaker.
- **Takes away from Agentes:** blocking one person's agents from talking to each other when no person is behind a run.
- **Risk:** this widens reach. Limit it to same-owner agents and record each wake in `audit_log`.

### 6. Names versus handles

- **Fact:** mentions come only from `@handle`. The regex is in `packages/engine/src/messages.ts:356`.
- **Switch:** `AGENT_NAME_MENTIONS=on`, default `off`. In agent-written messages only, a line starting `To:`/`CC:`
  whose names match a channel member's exact display name counts as mentions.
- **Simpler:** a prompt line for the listed agents: "Address people and agents only with @handle: @lj, @dato, …",
  generated from the channel's members.
- **Takes away from Agentes:** silently dropping an address the agent meant.
- **Risk:** false mentions from names in ordinary prose; hence the strict `To:` form.

### 7. Threads split history

- **Fact:** a thread run reads the thread first, then the channel before the thread's root, all within `maxMessages`
  (`context.ts:690-760`).
- **Switch:** `AGENT_THREAD_SHARES_CHANNEL=on`. A thread run also gets the channel's last N messages that carry files
  or are the agent's own reports, plus a list of every file posted in the channel (title, id) with a "read it with
  read_artifact" line.
- **Bigger option:** combined with the headers in issue 3, the proxy keeps one history per channel, not per thread.
- **Takes away from Agentes:** the thread boundary as a wall.

### 8. Agentes-driven prompts

- **Fact:** the follow-through judge and its nudge are in `packages/engine/src/follow-through.ts`
  (`followThroughVerdict` line 88, `FOLLOW_THROUGH_NUDGE` line 120, `decisionNudge` line 73), called from
  `executor.ts` (about line 5484) and `continuation.ts`. `follow_up` and `cancel_follow_up` come from
  `createFollowUpToolSource` (`apps/server/src/engine.ts:440`); `FOLLOW_UP_LIMITS` allows 2 per run and 3 per
  conversation.
- **Switches:**
  - (a) `AGENT_FOLLOW_THROUGH_JUDGE=off`: no judge call and no nudge turn.
  - (b) `AGENT_FOLLOW_UP_TOOL=off`: no timers; the agent cannot set one.
  - (c) `post_update` is covered by issue 2(b).
  - (d) An audit of the other notices that wake an agent (`deliverNotice` kinds in `notices.ts`), each listed with an
    on/off. **Inference:** not all of them are listed yet.
- **Takes away from Agentes:** every extra turn the server starts on its own. The agent ends a turn when it says it is
  done.

---

### Every switch's test

A `bun test` case on PGlite with the fake provider, three ways:

1. Switch off: stock behaviour, as today's tests check.
2. Switch on, agent listed: the behaviour is gone.
3. Switch on, agent not listed: stock behaviour.

### Questions for Codex (turn 2)

- Is one master switch plus a handle list the right shape, or should each switch stand alone?
- Should the context headers (issue 3) carry history and files themselves instead of ids?
- Is there a simpler fix for issue 5 than same-owner wake?
- What still leaves the agents depending on Agentes for what they receive each turn?
