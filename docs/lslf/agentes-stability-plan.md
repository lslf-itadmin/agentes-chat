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
- **Proxy as the source of truth (revised after Codex turn 2):** send stable ids on every custom-endpoint call, using
  the existing `withHeaders` (`custom.ts:172`): `X-Agentes-Org`, `X-Agentes-Run`, `X-Agentes-Agent`, and for reference
  `X-Agentes-Channel` and `X-Agentes-Thread`. Switch: `CUSTOM_ENDPOINT_CONTEXT_HEADERS=on`, default `off`.
  - **Fact:** one channel's history is not one reader's history. In an agents' DM every person's consultations land
    together, and `context.ts` keeps only the messages made for the run's own reader (`forSamePerson`,
    `context.ts:1714`, using `readerOf`). Explicit reads in that DM follow the same rule (`agentsDmReads`,
    `agents-dm-reads.ts`).
  - **Change:** the proxy never reads history by channel or thread id with a token of its own. It reads by **run**:
    a server endpoint, `GET …/runs/{runId}/history` (needs an LSLF token only the proxy holds), returns the messages
    and file ids that run may read, filtered by the same code as the window (`forSamePerson`, `agentsDmReads`,
    channel access). The channel and thread ids are labels, not keys.
  - **Until that endpoint exists:** no history header is sent for an agents' DM, and the proxy treats a channel it
    has no run-scoped read for as window-only.
  - **Inference:** this fork has no run-scoped read API today; whether an existing API token type fits is not
    checked. The endpoint is new code and needs its own review.
  - **Testing needs:** in an agents' DM holding two people's exchanges, the run-scoped read returns only the current
    reader's, exactly what the window would show uncapped; a run of another workspace is refused.

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

- **Fact:** `canTalkTo` (`packages/engine/src/audience.ts:208`) first lets the agent's owner through (line 209), then
  refuses a null `userId` unless the target's `audienceMode` is `"everyone"` (lines 212-213). A run with nobody behind
  it speaks as `NO_PERSON`. The refusal text comes from `unreachableWhy` (`continuation.ts:857`).
- **Fact:** `authority.ts` keeps accountability apart from authority: a `routine` run's creator stays accountable "but
  the run never acts as them", and an `unattended` run "works as the agent itself" and is refused what needs a
  person's request.
- **Fact:** `ask_agent`/`tell_agent` already use one narrow stand-in: for a routine's run, the routine's creator is the
  person checked (`consultations.ts:131-134`, `person = behind ?? routine?.creatorUserId`). An agent's own unattended
  work (`reason: "agent"`) gets no stand-in.
- **No-code options:** (i) the target's audience set to `people` with LJ named does **not** help: a null person fails
  line 213. (ii) The target's audience set to `everyone` does help (line 212), but opens the agent to every member.
- ~~Switch: `AGENT_SAME_OWNER_WAKE`, acting as the owner.~~ Withdrawn after Codex turn 2 (see "Changes after Codex
  turn 2").
- **Switch (revised):** `LSLF_AGENT_WAKE_PAIRS`, default empty. A list of directed pairs LJ writes by hand, e.g.
  `claudevcoo>dato,dato>claudevcoo`. The env var is the explicit delegation: LJ, the owner of both agents, authorizes
  that one named agent may wake another named agent. Rules:
  1. It applies only when the run is `unattended` with reason `agent`. A `person` run keeps today's check; a `routine`
     run keeps today's creator rule.
  2. Both agents must have the same `ownerUserId`, and that owner must still be a member who may talk to agents.
     Otherwise the pair is ignored.
  3. `canTalkTo` is not changed and the owner is **not** substituted as the speaker. The pair check sits beside it, in
     the wake paths (`reach.ts` for mentions, `consultations.ts` for `ask_agent`/`tell_agent`).
  4. The woken run keeps the real authority: `unattended`, reason `agent`, nobody behind it. It works as the agent
     itself; anything that needs a person's request stays refused; approvals and pauses go to the owner, as today.
  5. Every wake through a pair writes an `audit_log` row (`agent.wake_pair`, both agents, the run ids).
  6. The other brakes stay: a target switched off, or not taking hand-offs (`wakeRefusal`), still refuses.
- **Takes away from Agentes:** blocking two agents LJ named from reaching each other when no person is behind a run.
- **Risk:** this is the one switch that touches a permission check (AGENTS.md rule 6). It widens reach only for pairs
  LJ names, and never lends a person's authority. LJ must approve it explicitly in the brief before code.
- **Testing needs:** a pair wakes, and the woken run's `runAuthority` is `unattended`; a pair across two owners is
  ignored; a `person` run is unaffected; a tool that needs a person is still refused in the woken run; one audit row
  per wake.

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
- **Bigger option (revised after Codex turn 2):** combined with the run-scoped read in issue 3, the proxy keeps one
  history per channel **and reader**, never per channel alone. In an agents' DM, the reader (`readerOf`) is part of
  the key. **Fact:** `AGENT_THREAD_SHARES_CHANNEL` above reads only through the server's context builder, so it keeps
  every filter as is; only the proxy-side option needed this change.
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

### Changes after Codex turn 2

Codex left two comments (both P1). Both are accepted.

| #   | Codex comment (turn 2)                                                                              | Answer   | Change                                                                                                                                                       |
| --- | --------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Issue 5: the owner as speaker bypasses the audience check and lends authority nobody gave.          | Accepted | `AGENT_SAME_OWNER_WAKE` withdrawn. New `LSLF_AGENT_WAKE_PAIRS`: pairs LJ names, checked beside `canTalkTo`; the woken run stays `unattended`; audit per wake. |
| 2   | Issues 3 and 7: proxy history by channel mixes requesters that `forSamePerson` keeps apart in DMs.  | Accepted | The proxy reads by run, through a server endpoint with the same filters; ids are labels only; no history header for agents' DMs until then; issue 7 keys by reader. |

**Fact:** Codex did not comment on issues 1, 2, 4, 6 and 8 or on the turn 2 questions; they are unchanged. The
question of what still leaves the agents depending on Agentes each turn was not answered, so it stays open for turn 4.

### Every switch's test

A `bun test` case on PGlite with the fake provider, three ways:

1. Switch off: stock behaviour, as today's tests check.
2. Switch on, agent listed: the behaviour is gone.
3. Switch on, agent not listed: stock behaviour.

### Questions for Codex (turn 4)

- Is one master switch plus a handle list the right shape, or should each switch stand alone?
- Should the context headers (issue 3) carry history and files themselves instead of ids?
- Is `LSLF_AGENT_WAKE_PAIRS` (issue 5, revised) narrow enough, or should a pair also be limited to one channel?
- Is a run-scoped history endpoint (issue 3, revised) the right place for the requester filter?
- What still leaves the agents depending on Agentes for what they receive each turn?
