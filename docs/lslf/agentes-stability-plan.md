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

## Turn 3 addition: every automatic ability and its switch

LJ (Nov 24, 2026): "I want a switch to be able to manage all detectable abilities."

**How this list was made (fact):** a code sweep of `packages/engine/src` (every file named in CLAUDE.md's map, plus
`context/*`, `tools/*`) and `apps/server/src/workers.ts`, at base v0.1.2. An **ability** here is anything by which
Agentes acts on, for, or around an agent without a person asking for it in that message. Each row's "where" was read
in code. **Not checked:** which of these fire on LJ's install (that needs the runs' `context` steps and the outbox
rows on the server).

**Correction to the brief's list (fact):** `agent-status.ts` and `agent-media.ts` don't call the agent's own model. Every
side request (judges, router, summaries, talker, status line, media, thread titles, auto model, tool loading) goes to
TypeSafe Jev when the server has its key, or else the workspace's cheap model (`resolveSummaryModel`,
`context/summaries.ts:55`; `cheapModelForOrg`, `router.ts:615`), billed to the workspace. None uses
`agents.credential_id`. One exception: the plan router step (`router-plan.ts:150`) uses the message author's own
Claude/ChatGPT sign-in on their computer.

### The one control object

**Fact:** `agents.autonomy_brakes` is a `jsonb` column that already exists (`packages/db/src/schema/agents.ts:161`,
default `{}`), validated in code by `autonomySettings` (`autonomy-settings.ts:96`). So per-agent switches need **no
migration** (AGENTS.md rule 4).

**Fact:** saving an agent's brakes keeps only the fields `autonomySettings` knows (`chosenAutonomy`,
`autonomy-settings.ts:126`, called from `agents.ts:477-486`). A new key would be dropped on the next save unless the
validator learns it. Stock v0.1.2 reads only its known fields, so switching back to the official image ignores the new
key (its next brakes save drops it; nothing breaks).

**Proposal:**

- One type, `LslfControls`, with one key per row below (the "Control" column). Every key's default is **stock**: with
  nothing set, behaviour is exactly v0.1.2.
- Stored at `agents.autonomy_brakes.lslf = { preset?: "stock" | "steady", set?: { <key>: <value> } }`, validated by a
  new `lslfControls(raw)` beside `autonomySettings`, and kept by `chosenAutonomy`.
- Workspace default: env var `LSLF_CONTROLS_PRESET=stock|steady`, default `stock`. **Inference:** LJ's server holds
  one workspace, so server scope is workspace scope. If it holds more, a second env var
  `LSLF_CONTROLS_ORGS=<org id>,…` limits it.
- Resolution, most specific wins: the agent's `set` → the agent's `preset` → `LSLF_CONTROLS_PRESET` → stock.
- **Resolved once per run.** The executor resolves the controls when the run starts and writes them on the run's first
  `context` step, so a change mid-run never changes a run in flight, and every run says which controls it ran under.
  That is the "stable at every step" part.
- Server-only knobs that have nothing to do with one agent stay env vars, as in turn 1: `CUSTOM_ENDPOINT_TIMEOUT_MIN`
  (issue 1), `CUSTOM_ENDPOINT_CONTEXT_HEADERS` (issue 3), the read-cap ceiling (issue 4).
- This **replaces** turn 1's handle lists (`LSLF_STEADY_AGENTS`, `LSLF_STEADY_MODE`) for anything per agent: an agent
  is "listed" when its preset or the server's is `steady`. To be confirmed in turn 5.

**One place to manage them:** an "Agent controls" card on each agent's page, next to Autonomia, with the preset
selector (Stock / Steady) on top and one row per key, grouped as below. Each row shows the resolved value and where it
came from (server preset, agent preset, set here). Settings › General shows the server preset read-only. Who may change
them: whoever may change the agent's Autonomia today. No new permission (AGENTS.md rule 6). Each change goes in
`audit_log` (`agent.controls`). The card is a UI change, so it follows `.claude/skills/ui-polish`. An operator read of
the resolved controls (`GET /api/operator/v1/orgs/{orgId}/agents/{agentId}/controls`) is optional.

**Labels below.** Scope **A** = per agent (from the control object), **S** = server env var, **W** = workspace setting
that exists today. "Steady" is the value in the `steady` preset. "Keep" = cannot be switched off safely; the row gives
the narrowest control instead. Every "where" is a fact from code unless marked *(inference)*.

### A. Turn ends and nudges

The server judges each finished turn and may add a turn of its own (a nudge) or hold the reply.

| #   | Ability                     | Where                                                                                          | What the agent / model sees                                                 | Switch today                                                       | Control (A unless said): values, default → steady                                  | Risk if off                                                                          |
| --- | --------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| A1  | Turn-end controller         | `continuation.ts:598` `decideTurnEnd`; `CONTINUE={maxPerRun:2, routineMaxPerRun:1}` (:34); judge | Up to 2 extra nudge turns; a reply held instead of posted                   | Hard-coded                                                         | `turnEnd`: `stock` \| `plain` (the run ends when the model ends its turn; no judge, no nudge) → `plain` | Give-ups, unbacked claims and wrong wording go out unchallenged                      |
| A2  | Answer nudge                | `reply-policy.ts:25` `ANSWER_NUDGE`                                                            | "You were addressed directly; answer the person."                           | Hard-coded                                                         | `nudges` list; each kind below on/off. Steady keeps only `secret`               | A direct question can go unanswered (silence)                                        |
| A3  | Decision nudge              | `continuation.ts:642` `decisionNudge`                                                          | Nudge with a decision's result                                              | Hard-coded                                                         | `nudges.decision` → off                                                         | The person isn't told the outcome of their decision                                  |
| A4  | Widget nudge                | `continuation.ts:322` `WIDGET_NUDGE`                                                           | Nudge to finish a widget                                                    | Hard-coded                                                         | `nudges.widget` → off                                                           | A widget refresh can end without one                                                 |
| A5  | Open-request nudge          | `executor.ts:~5369` `openRequestNudge`                                                         | Nudge that the person's request is still open                               | Hard-coded                                                         | `nudges.openRequest` → off                                                      | The run can stop with the request half done                                          |
| A6  | Untried give-up + held read | `continuation.ts:63` `untriedNudge`, `:82` `heldReplyRead`; judge                              | "I can't" reply held; nudge lists means not tried                           | Hard-coded                                                         | `nudges.untried` → off                                                          | More "I can't" answers reach people                                                  |
| A7  | Secret nudge                | `continuation.ts:170` `SECRET_NUDGE`, `:664`; judge                                            | Reply that asks for a secret in chat is held; nudge to `request_secret`     | Hard-coded                                                         | `nudges.secret` → **keep on** in steady                                         | A password asked for and typed in plain chat. **Safety:** steady keeps it            |
| A8  | Unbacked-claim nudge        | `continuation.ts:315` `UNBACKED_NUDGE`, `:668`; judge                                          | Nudge; claim kept out of a routine's record                                 | Hard-coded                                                         | `nudges.unbacked` → off                                                         | A claimed result nothing produced reaches people                                     |
| A9  | Ask nudge / mission ask     | `continuation.ts:163` `ASK_NUDGE`; `follow-through.ts:134` `MISSION_ASK_NUDGE`; judge          | Nudge, then a question card                                                 | Hard-coded                                                         | `nudges.ask` → off                                                              | A question in plain text rather than a card; nothing waits on the answer             |
| A10 | Findable-question nudge     | `continuation.ts:157` `findableNudge`; judge                                                   | Nudge: "find it yourself"                                                   | Hard-coded                                                         | `nudges.findable` → off                                                         | More questions to people the agent could answer                                      |
| A11 | Local-paths wording         | `continuation.ts:275` `localPathsCited`, `:303`                                                | Nudge to rewrite paths people can't open                                    | Hard-coded (regex)                                                 | `nudges.localPaths` → off                                                       | Replies cite paths on the computer                                                   |
| A12 | Tool-name wording           | `continuation.ts:191` `toolsNamed`, `:630`                                                     | Nudge to stop naming internal tools                                         | Hard-coded                                                         | `nudges.toolNames` → off                                                        | Replies mention tool names                                                           |
| A13 | Follow-through judge        | `follow-through.ts:88`, `:120`, `:127` (issue 8a); judge                                       | Nudge, once, when the run said it would do more                             | Hard-coded                                                         | `nudges.followThrough` (= issue 8a) → off                                       | "I'll do X next" with nothing bringing it back                                       |
| A14 | Asking means waiting        | `brakes.ts:46` `endsAsking`, `:895` `askStillOpen`                                             | A run ending on a question stops; its follow-ups hold                       | Hard-coded                                                         | `askWaits`: on \| off → on                                                      | Off: an agent asks and carries on before the answer. Kept in steady: it is the agent's own words |
| A15 | Silence sentinel            | `reply-policy.ts:19` `NO_REPLY`, `:248`                                                        | `NO_REPLY` never posted                                                     | Hard-coded                                                         | **Keep.** It is the agent's own signal, not Agentes acting                     | —                                                                                    |
| A16 | `pass` tool and "why called" lines | `reply-policy.ts:22` `PASS_TOOL`, `:28-79` `WHY_*`, `:116`                              | A `pass` tool on runs nobody named; a line saying why it was called         | Hard-coded                                                         | `replyPolicy`: `stock` \| `plain` (no `pass`; one fixed line naming the trigger) → `plain` | Router-woken agents can't bow out; more replies when the router is on              |
| A17 | Reaction-restate drop       | `context.ts:272` `restatesReaction`, used `executor.ts:5286`                                   | Text that only repeats a `react` is not posted                              | Hard-coded                                                         | `dropRestated`: on \| off → off                                                 | A reaction plus a one-line echo                                                      |

### B. The run loop

| #   | Ability                     | Where                                                                                          | What the agent / model sees                                                 | Switch today                                                       | Control                                                                          | Risk if off                                                                          |
| --- | --------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| B1  | Step cap and wrap-up note   | `executor.ts:911` `WRAP_UP_TURNS=2`, `:914-931`, `:4359`                                       | "Wrap up" note near the cap; then "I ran out of steps before finishing."    | `AGENT_MAX_TOOL_TURNS` (S, default 200)                            | Cap: **keep** (runaway backstop). `wrapUpNote`: on \| off → off                 | Off note: the run hits the cap mid-step without a summary                            |
| B2  | Stuck detector              | `stuck.ts:27` `STUCK={sameCall:3, sameError:3, failing:4, nothingNew:5, window:8, verdict:0.6}`; judge | `STUCK_NOTE`, then the run ends (`STUCK_END_*`)                             | Hard-coded                                                         | `stuck`: `stock` \| `note` (note only, never ends the run) \| `off` → `off`    | A loop runs to `AGENT_MAX_TOOL_TURNS`; the budget check still stops it               |
| B3  | Auto-move to background     | `works.ts:59-62` (4 min, 20 calls, 90 s); `executor.ts:4223-4266`                              | `workStartsNote`; an anchor post; the work leaves the conversation          | `deps.workAutoAfterMs` (not from config); PR #10 adds the env var  | `autoMove` (= issue 2a, PR #10): on \| off → off                                | Long work stays in the conversation; the conversation's run is busy longer            |
| B4  | Work tools                  | `apps/server/src/engine.ts:438` `createWorkToolSource`                                         | `work_in_background`, `post_update`, `steer_work`, `stop_work`              | Hard-coded                                                         | `workTools` (= issue 2b): on \| off → off                                       | The agent can't move work out itself                                                 |
| B5  | Work check-in and server update | `works.ts:39` `WORK_LIMITS`, `:690` `checkInWork`, `:743` `postFallbackUpdate`             | `work_check_in` notice; the server posts an update in the agent's name      | Hard-coded                                                         | Off with `workTools` (= issue 2c)                                               | No update deadlines on background work                                               |
| B6  | Burst wait                  | `burst.ts:8` `BURST_MAX_WINDOWS=4`, `:15` 1.2 s; `router.ts:702` `ROUTER_QUIET_MS=2500`        | A short wait; quick messages read as one                                    | `deps.quietMs` (not from config)                                   | `burstWait`: ms, 0-10,000 → stock                                               | With 0, each quick message starts its own run. Steady keeps it: one turn per burst is steadier |
| B7  | Outage park and stand-in    | `executor.ts:1047` `OUTAGE_PARK` (2/15/30/60 min, 24 h), `:967` `PROVIDER_UNAVAILABLE_TEXT`    | Server posts "My AI provider isn't answering right now…" and "My AI is back." | Hard-coded                                                       | Parking: **keep** (retry, not judgment). `outageText`: on \| off → off          | Off text: people see silence while the provider is down                              |
| B8  | Computer drop retry         | `executor.ts:864-890` (2 min, 3 drops, 15 s), `interruptedTurnPrompt`                          | "Your previous turn was cut off…" with the calls not to repeat              | `deps.computerDropGraceMs`                                         | **Keep.** Narrowest: none; it re-sends the agent's own turn                     | Off would lose the turn or repeat its calls                                          |
| B9  | Computer-queue note         | `executor.ts:887` `COMPUTER_QUEUE_NOTE_MS=10min`                                               | A chat note that the run waits for the computer                             | Hard-coded                                                         | `queueNote`: on \| off → off                                                    | People aren't told why it hasn't started                                             |
| B10 | Stale-run recovery          | `cancel.ts:42-43` (20 s / 2 min); `recovery.ts:32` `MAX_RECOVERIES=2`, `:38` 6 h               | A turn re-sent, or "Interrupted by a server restart"                        | Hard-coded                                                         | **Keep.** Recovers a dead worker                                                | Off: runs stay "running" forever (see issue 2's stuck task)                          |
| B11 | Plan-limit grace, usage pause | `executor.ts:869`; `usage-pause.ts:25-28`, `:345` `LONG_WORK`                                | Run parked near a plan or budget limit; resumed later                       | Agent `brainExtraUsage`                                            | **Keep.** Budget safeguard (AGENTS.md rule 6)                                   | —                                                                                    |
| B12 | Spill to another computer   | `spill.ts:24` `spillPlan`, `:108`                                                              | The plan moves machines *(inference: nothing in the prompt)*                | Hard-coded                                                         | `spill`: on \| off → stock                                                      | Off: work waits for its own computer                                                 |

### C. What the model receives each turn

| #   | Ability                       | Where                                                                                       | What the model sees                                                          | Switch today                           | Control                                                                           | Risk if off                                                                       |
| --- | ----------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| C1  | History window                | `context.ts:704/757`                                                                        | The last N messages; older ones absent                                       | `AGENT_CONTEXT_MESSAGES` (S, 30)        | `historyMessages`: 1-500 (A, overrides the env var) → 100                         | Bigger prompts, more cost per turn                                                |
| C2  | History anchor                | `context.ts:2371` `HISTORY_ANCHOR_WINDOW=12`, `ANCHOR_EVERY=5`, `:2379`                     | Up to 11 more of the oldest messages dropped                                 | Hard-coded                             | `historyAnchor` (= issue 3c): on \| off → off                                     | Less prompt caching: higher cost per turn                                         |
| C3  | Old-message cut               | `context.ts:2386` `KEEP_WHOLE=8`, `LONG_OLD_MESSAGE=1500`, `OLD_MESSAGE_START=600`          | `[… cut: N more characters; expand <id> reopens it]`                         | Only when `expand` is offered          | `cutOld` (= issue 3b): on \| off → off                                            | Bigger prompts                                                                    |
| C4  | This-turn and current-line clips | `context.ts:404` `THIS_TURN_MAX_CHARS=2000`, `:485` `CURRENT_LINE_MAX=300`               | `[… cut; look it up…]`, a trailing `…`                                       | Hard-coded                             | `turnClips`: on \| off → off                                                      | A very long "where you are" block                                                 |
| C5  | Old tool-step cut             | `context-budget.ts:208` `KEEP_TOOL_STEPS=4`, `:212`, `:217`, `:268` `cutOldToolSteps`       | Older long calls and results truncated, `expand` reopens                     | With `expand` *(inference: `deps.toolsOnDemand`)* | `cutOldTools`: on \| off → off                                          | Long runs grow fast; compaction (C6) starts sooner                                |
| C6  | Context-window compaction     | `context-budget.ts:45-98` (3 chars/token, 5% margin, 500k cap); judge picks what goes        | `[Result removed to save space:…`                                            | `deps.contextWindowTokens`             | **Keep** (an overflowing call fails). Narrowest: `compaction`: `judge` \| `oldest` (drop oldest results first, no judge) → `oldest` | —                                                    |
| C7  | Old-image drop                | `context-budget.ts:307` 15,000,000 chars, `:310`                                            | Older images missing                                                         | Hard-coded                             | **Keep.** A provider limit                                                       | —                                                                                 |
| C8  | Read caps                     | Issue 4's table                                                                             | `[truncated]`, cut files and pages                                           | Hard-coded                             | `readMaxChars` (A, under the S ceiling of issue 4) → 400,000                      | Cost and context size                                                             |
| C9  | Injected blocks               | `context.ts:294` recent actions (12, 140 chars, `QUIET_TOOLS`); `:927-945` team roster, teammates now, also answering; `:1351` work handed off; `:752` parked asks; `waiting.ts:94/143` waiting on a person; `:1110` skills list | `# Recent actions…`, `# Your team`, `# Your teammates now`, `# Work you handed off here`, … | Hard-coded                     | `blocks`: list of block names to send → steady keeps `handedOff`, `waitingOnPerson`, `skills`; drops `recentActions`, `workElsewhere`, `teammatesNow`, `alsoAnswering`, `parkedAsks` | The agent knows less of what its team does now                    |
| C10 | Catch-up text                 | `catch-up.ts:12-16` (10 min, 24 h, 50 msgs); `executor.ts:3103`                             | A catch-up summary of what was posted since                                  | Hard-coded                             | `catchUp`: on \| off → off (with C1 at 100 the window already holds it)            | After a long pause, messages beyond the window are unseen                         |
| C11 | Catch-up triage               | `catch-up-triage.ts:24-32`; judge                                                           | The run ends with no reply when every ask looks closed                       | Hard-coded                             | `catchUpTriage`: on \| off → off                                                  | Replies to asks already closed                                                    |
| C12 | Memory retrieval and the A/B holdout | `context/tools.ts:1445` `retrieveForRun`; `context/scorecard.ts:11` `HOLDOUT_EVERY=10`, `memoryArmOf` | Retrieved memory; 1 run in 10 gets the older memory set                | Hard-coded                             | `memory`: `stock` \| `fixed` (no holdout: same set every run) \| `off` → `fixed`  | Off: no saved facts at all. `fixed` loses only the comparison                     |
| C13 | Tool loading by judge         | `tool-loading.ts:48` `chooseToolGroups` (0.3, 1.5 s), `:169`; judge                         | Some tool groups listed, the rest behind `find_tools`                        | Hard-coded                             | `toolLoading`: `judge` \| `all` → `all`                                           | A bigger tool list in every prompt                                                |
| C14 | Automatic model               | `auto-model.ts:99` `chooseAutoModel`, `:189`; judge                                         | A different model and effort per run                                         | Agent model `auto` vs a named model    | **No code:** set the agent's model and effort by name. Steady says so             | —                                                                                 |
| C15 | Untrusted envelope            | `untrusted.ts:46` `untrustedBlock`, `UNTRUSTED_MAX_CHARS=8000`                              | `<external_data …>`, `[hidden characters removed]`, cut text                 | Hard-coded                             | **Keep** (prompt injection). Narrowest: its cap follows `readMaxChars`            | —                                                                                 |
| C16 | Same-person filter            | `context.ts:766` `forSamePerson`                                                            | In an agents' DM, only this reader's exchanges                               | Hard-coded                             | **Keep** (privacy; Codex turn 2)                                                  | —                                                                                 |
| C17 | Rules, style and origin notes | `context/rules.ts:44/83` (600 chars); `context.ts:819-820`; `agent-style.ts:37`             | People's rules; language, style, where a thread came from                    | `organization_members.agent_style`     | Rules: **keep** (people's words). `styleNotes`: on \| off → stock                  | —                                                                                 |
| C18 | Hand-off and routine record caps | `hand-off.ts:25` `MAX_HAND_OFF=8000`; `context.ts:1587` `MAX_RECORD_CHARS=4000`          | Truncated report, truncated record                                           | Hard-coded                             | Follow `readMaxChars`                                                             | Bigger prompts                                                                    |

### D. Wakes, routing and stand-ins

| #   | Ability                        | Where                                                                                    | What the agent sees / what happens                                   | Switch today                                                                  | Control                                                                      | Risk if off                                                                    |
| --- | ------------------------------ | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| D1  | Router                         | `router.ts:777` `routeMessage`, `:255` policy; chain `router-jev.ts:263`                 | A run started by "router" on a message that named nobody             | `ROUTER_ENABLED` (S); agent `wakeRouter` (A); `ROUTER_MIN_SCORE`, `ROUTER_STRATEGY`, `ROUTER_MODEL` | **Exists.** Steady sets `wakeRouter=false`                         | Agents answer only when @mentioned                                            |
| D2  | Agent chime-in, default picks  | `router.ts:745` 0.75; `:1600-1652` (`DEFAULT_PICKS_PER_HOUR=6`, …)                       | An agent brought in by another's message or by default               | Part of the router                                                            | Covered by `wakeRouter`                                                      | —                                                                              |
| D3  | Social reaction stand-in       | `router.ts:1777` `socialReaction`, `:310`, `ACK_MAX_WORDS=5`                             | A greeting gets an emoji from the agent, no run                      | Hard-coded                                                                    | `socialReactions`: on \| off → off                                           | "Thanks" gets no reaction                                                      |
| D4  | Agent-mention judge            | `judge.ts:379` 0.6, `:385` 0.85, `:386` hop 4; `jobs.ts:320`                             | A mention that isn't a request doesn't wake; `wake_skipped`          | Agent `wakeAgents` `judge` \| `always` \| `off` (A); `ROUTER_MENTION_THRESHOLD` (S) | **Exists.** Steady sets `wakeAgents=always`                          | Every @mention wakes, credits and references too; stretch and hop limits still apply |
| D5  | Wake words                     | `wake-words.ts:25/74`                                                                    | A word wakes it like a mention                                       | `wakeWords`, `wakeWordsFrom` (A; empty by default)                            | **Exists**                                                                   | —                                                                              |
| D6  | Talker (stand-in reply)        | `talker.ts:40-46` (20 s, 30 s, 6 s, 600 chars), `:69`; org cheap model                   | People get a quick reply in the agent's voice; agent gets `talker_reply` | Hard-coded                                                                | `talker`: on \| off → off                                                    | No quick answer while a long run works                                         |
| D7  | Stop judge                     | `judge.ts:316` `isStopRequest` (80 chars, 0.6); `steering.ts:192`                        | A short "stop" from a person cancels the run; `run_stopped`          | Hard-coded                                                                    | `stopJudge`: on \| off → **on** in steady: it acts only on a person's words | Off: "stop" in chat doesn't stop; the Stop button still does                   |
| D8  | Live steer                     | `live-steer.ts:43-46`, `:107` `PASSED_ON_NOTE`                                           | A person's message enters a computer brain's turn mid-run            | Depends on the brain                                                          | `liveSteer`: on \| off → stock                                               | Off: the message waits for the next turn                                       |
| D9  | Wait handling judge            | `waits.ts:287` `onMessageWhileWaiting`, `:231`, `:181` `MEANWHILE`; judge                | A message ends a wait or detaches it                                 | Hard-coded                                                                    | `waitJudge`: `judge` \| `explicit` (only a reply to the wait's card ends it) → `explicit` | Off-by-judge: a plain message no longer ends a browser-help wait            |
| D10 | Message hold, run inbox        | `run-hold.ts:19`; `run-inbox.ts:77/128`, sweep 30 s / 60 min                             | Messages queued on a live run, or a run of their own                 | Hard-coded                                                                    | **Keep.** Delivery: nothing sent to an agent is lost                         | —                                                                              |
| D11 | Parked wake, mention report once | `dispatch.ts:35-44` (30 s, 5 min); `:350-434` (35 min)                                 | A wake delayed until the computer is free; one combined wake         | Hard-coded                                                                    | `mentionReport`: `once` \| `each` → stock                                    | `each`: one wake per reply                                                     |
| D12 | Reach notes, wake skipped      | `reach.ts:60/102`; `continuation.ts:824/849/873`                                         | "Couldn't wake @x because…" in the next context                      | Hard-coded                                                                    | **Keep.** It tells the agent its message didn't arrive                       | —                                                                              |
| D13 | Thread assess                  | `thread-assess.ts:190`; org cheap model                                                  | Nothing for the agent; a title and "resolved?" for people            | Hard-coded                                                                    | `threadAssess`: on \| off (W-wide, S) → off                                  | Threads keep their first line as title                                         |

### E. Brakes on work nobody asked for (ADR 0131)

| #   | Ability                  | Where                                                                                     | What the agent sees                                                   | Switch today                                                         | Control                                                              | Risk if off                                                     |
| --- | ------------------------ | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------- |
| E1  | Costly-step gate, PR cap | `brakes.ts:130` `costlyGate` (PR, install, >40 steps `LONG_STEPS`); `:122/184`            | `autonomy.needs_go` / `.declined` / `.never` / `.pr_limit` refusals   | `costly`, `go[]`, `never[]`, `maxPrsPerHour` (A)                     | **Exists.** Steady: unchanged (LJ sets per agent)                    | —                                                               |
| E2  | Alert triage judge       | `brakes.ts:478` `triageItem` (0.6); judge                                                 | Noise never wakes the agent                                           | Hard-coded                                                           | `triage`: on \| off → off                                            | Every unrequested item wakes it; E4 still stops loops           |
| E3  | Duplicate linking        | `brakes.ts:554-556` (5 min)                                                               | agent_note "The same item was reported again…"                        | Hard-coded                                                           | `dedupeItems`: on \| off → stock                                     | The same alert starts a second run                              |
| E4  | Loop stop                | `brakes.ts:453` `LOOP_WINDOW_MS=24h`, `LOOP_MAX=3`, `:737`                                | Not woken; a message to the owner                                     | Hard-coded                                                           | **Keep** (runaway)                                                   | —                                                               |
| E5  | Noise digest             | `brakes.ts:771-777` (1 h); worker 10 min                                                  | Nothing (for the owner)                                               | Hard-coded                                                           | Off with `triage` off                                                | —                                                               |
| E6  | Defer at capacity        | `brakes.ts:460-464`, `:692-700`                                                           | A delayed wake                                                        | `maxUnrequested` (A, 1-20)                                           | **Exists**                                                           | —                                                               |
| E7  | Who may call whom        | `brakes.ts:861`; `autonomy-settings.ts:135-141`                                           | `notCallableText`                                                     | `callAgents`, `callAgentIds`, `project` (A)                          | **Exists.** Issue 5's pairs sit beside it                            | —                                                               |
| E8  | Stretch limits           | `stretch.ts:33` `{runs:50, unattendedRuns:10, budgetShare:0.2}`, `:39` 4 h, `:61` 10      | A tool refused; a card with Continuar                                 | Hard-coded; hops `AGENT_MAX_HOPS` (S)                                | **Keep** (runaway). Narrowest: `stretchRuns` 10-200 → stock         | —                                                               |
| E9  | Consultation expiry      | `consultations.ts:62` 15 min, `:69` 2 h, `:74` 24 h, `:2011`                              | "No answer" notice                                                    | Hard-coded                                                           | `consultTtlMin`: 15-1440 → 60                                        | Asks wait longer before failing                                 |
| E10 | Chain cap, note dedupe   | `consultations.ts:82` `MAX_CONSULTATION_CHAIN=4`, `:606` 1 h                              | Refusal; dropped note                                                 | Hard-coded                                                           | **Keep** (loops)                                                     | —                                                               |

### F. Timers, follow-ups and notices

| #   | Ability                  | Where                                                                                | What the agent sees                          | Switch today                                         | Control                                                                 | Risk if off                                            |
| --- | ------------------------ | ------------------------------------------------------------------------------------ | -------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------ |
| F1  | `follow_up` tool         | `follow-through.ts:59` `FOLLOW_UP_LIMITS={1440 min, 2/run, 3/conversation}`, `:452`  | A `follow_up` notice wakes it                | `wakeScheduled` (A) stops the wake, not the tool      | `followUpTool` (= issue 8b): on \| off → off                            | The agent can't set a reminder                         |
| F2  | Work follow-up           | `works.ts:1022` `followUpWork`                                                       | `work_follow_up` and a run                   | Hard-coded                                           | Off with `workTools`                                                    | —                                                      |
| F3  | Approval expiry          | `tools/gateway.ts:313` 24 h; `approvals.ts:1127`                                     | The run resumes with "expired"               | Hard-coded                                           | **Keep** (approval safeguard)                                           | —                                                      |
| F4  | Waking notices           | `delivery.ts:48` `deliverNotice`; kinds in `notices.ts:23`                           | See the list below                           | Hard-coded per kind                                  | `noticeWakes`: list of kinds that may start a run; others join the next turn → steady keeps `routine_handoff`, `consult_reply`, `wait_result`, `proposal_result`, `poll_result` | A late answer or a GitHub event waits for the next turn |

**Notice kinds (fact, `notices.ts:23`, `delivery.ts:30-48`):** `routine_handoff` wakes · `consult_reply` wakes (not when
re-reported) · `agent_note` legacy · `wait_result` joins or wakes · `talker_reply` never wakes (gone with `talker` off)
· `proposal_result` wakes · `poll_result` wakes · `follow_up` the line doesn't wake, the due notice does (gone with
`followUpTool` off) · `wake_skipped` never wakes · `work_check_in` never wakes (gone with `workTools` off) ·
`run_stopped` never wakes · `github_event` wakes *(inference: the wake flag at `git/github-events.ts:382` not
confirmed)* · `work_follow_up` starts or joins a run (gone with `workTools` off).

### G. Learning and memory upkeep (side requests on the workspace's model)

| #   | Ability                     | Where                                                                                  | What later prompts see                              | Switch today                                                       | Control                                                     | Risk if off                                            |
| --- | --------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------- | ------------------------------------------------------ |
| G1  | Learn after a turn          | `context/learn.ts:210/431`, `LEARN_DEFAULTS` (:56)                                     | New memory items and skill fixes                    | `LEARN_MAX_PER_AGENT_DAY=0` turns it off (S, all agents)           | `learn`: on \| off (A) → off                               | The agent stops learning from its own runs             |
| G2  | Thread reflection           | `context/reflect.ts:150`, `REFLECT_DEFAULTS` (:34); idle sweep `consolidate.ts:367`    | Facts, decisions, profiles                          | `REFLECT_*` (S) bound it but can't turn it off (minimums 2 and 1)  | `reflect`: on \| off (A) → off                             | No automatic facts from threads                        |
| G3  | Summaries                   | `context/summaries.ts:186/241`                                                         | `get_summary` and retrieval                         | `SUMMARY_MODEL` (S), `summary_model` (W) pick the model only       | `summaries`: on \| off (A) → off                           | `get_summary` returns nothing new                      |
| G4  | Daily consolidation and decay | `context/consolidate.ts:23` `DECAY`, `:50`; 14 d, 30 d                               | Faded items stop being retrieved                    | Hard-coded                                                         | `memoryUpkeep`: on \| off (A) → off                        | Memory grows; stale items stay                         |
| G5  | Merge by meaning            | `consolidate.ts:236/263`; `context/judgments.ts:35` thresholds; judge                   | Merged or superseded items                          | Hard-coded                                                         | `memoryMerge`: on \| off (A) → off                         | Duplicates and conflicts stay                          |
| G6  | How-to → skill, share, skill decay | `context/learned-skills.ts:456` (`LEARN_SKILL_AFTER`), `:655`, `:432/718` 30 d   | New skills appear; unused agent skills vanish       | `LEARN_SKILL_AFTER` (S) can't turn it off                          | `skillUpkeep`: on \| off (A) → off                         | Skill list changes only by people                      |
| G7  | Agent edits skills          | `learned-skills.ts:74/296` limits; judge                                              | A skill changed at once, or a proposal              | `agents_improve_skills` (W); skill's own `agents_improve`          | **Exists.** Steady: `agents_improve_skills=false` (changes wait for a person) | —                                     |
| G8  | Lessons from refusals and reactions | `context/feedback.ts:29/81/248` (👍 +0.1, 👎 −0.15)                          | Memory reranked; lessons saved                      | Hard-coded                                                         | `feedbackLearning`: on \| off (A) → off                    | People's corrections don't change memory               |
| G9  | Promotion proposals         | `context/proposals.ts:121/178`                                                         | After a person approves, `## Learned` instructions  | A person decides                                                   | Off with `learn` off; else stock                           | —                                                      |
| G10 | Skill auto-update           | `skill-updates.ts:313`                                                                 | Updated skill text                                  | `skills.auto_update` per skill (default off)                       | **Exists**                                                 | —                                                      |

### H. Other side requests and the right hand

| #   | Ability              | Where                                                                                 | What happens                                              | Switch today                                                      | Control                                                        | Risk if off                                      |
| --- | -------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------ |
| H1  | Status line          | `agent-status.ts:682/701/784/847`, 0.5 / 0.6 / 0.3, 30 s; judge                       | A status written for it; its own line replaced when stale | Hard-coded                                                        | `statusLine`: `judge` \| `plain` (from work state and `set_status` only) → `plain` | Teammates see a plainer status         |
| H2  | GIFs and stickers    | `agent-media.ts:223/368`, thresholds `{sometimes:.8, often:.6}`; Jev                  | A GIF or sticker posted after its reply                   | `agent_media` never\|sometimes\|often (W); `agents.media_replies` (A) | **Exists.** Steady: `media_replies=false`                   | —                                                |
| H3  | Team watch, welcome  | `team-watch.ts:157/265`; `right-hand-proactive.ts`                                    | The right hand messages people                            | `team_watch`, `welcome_people` (W)                                | **Exists.** Not about LJ's agents' turns; stock               | —                                                |
| H4  | Right-hand task follow-up | `right-hand-follow.ts:266/367` (4 h, 7 looks, 3 a day)                           | `wait_result` notices wake the right hand                 | Per person `remindOff`                                            | **Exists**                                                    | —                                                |
| H5  | Approvals digest, reminder email | `approvals-digest.ts:40-46`; `email.ts:1436`                              | A digest card; an email                                   | `digestOff` (person); `APPROVAL_REMINDER_HOURS` (S)               | **Exists**                                                    | —                                                |
| H6  | Feedback offers      | `feedback-offers.ts:21` (24 h, 7 d)                                                   | `offer_feedback` refused within the window                | `chat_prefs.feedbackAuto` (person)                                | Stock                                                         | —                                                |

### I. Safeguards: cannot be switched off (AGENTS.md rule 6)

These are listed so the inventory is complete. None gets an off switch. Where a narrower control exists today, it is
named.

| Ability | Where | Narrowest control that exists |
| --- | --- | --- |
| Run policy (who is behind a run decides allow / ask / refuse) | `tools/run-policy.ts:397`, refusals `:348` | `agents.approvals_level` `always` \| `risky` \| `never` (A, default `risky`) |
| Always-sensitive actions (merge, deploy, rollback…) | `tools/gateway.ts:100/127/147` | `approvals_level=never`; "Aprovar sempre" rules (`approval-rules.ts:84`); `agents.merge_repos` |
| Required `why` on an ask | `run-policy.ts:494-533`, `gateway.ts:1498` | none |
| Scopes and GitHub repo checks | `gateway.ts:1343-1352`; `tools/checks.ts:11` | the agent's grants and repos |
| Credential exfiltration block (routine-fed runs) | `gateway.ts:1404`, `:353` | none |
| Connector-first for secrets | `tools/connector-first.ts:164` | `person_said` |
| Budget reservation and checks | `gateway.ts:439+`, `:159-161`; `usage.ts:10` | budgets per agent and workspace |
| Workspace standing, agent hold | `standing.ts:67/277/294/316` | operator only |
| Audience, consultable | `audience.ts:192/208` | the agent's audience; `agents.consultable` |
| Hop backstop | `dispatch.ts:582` | `AGENT_MAX_HOPS` (S) |
| Team-action check (outside actions repeated) | `team-actions.ts:329`, 30 d | `action_check` (W). **Steady keeps it on:** it is the one check against sending the same outside action (an email to a client) twice. LJ may turn it off |
| Outbox fairness, leases | `outbox.ts:53/224/462` | `OUTBOX_*` (S) |

### The `steady` preset

**Off** (Agentes stops acting on its own): A1 and every nudge but A7; A16, A17; B1's note, B2, B3, B4, B5, B7's
text, B9; C2, C3, C4, C5, C10, C11, C13; C9's live-team blocks; C12's holdout; D3, D6, D9 (to `explicit`), D13; E2,
E5; F1 and the waking notices outside the kept list; G1-G6, G8; H1 (to `plain`); and through existing settings:
`wakeRouter=false`, `wakeAgents=always`, `media_replies=false`, `agents_improve_skills=false`.

**Raised:** C1 to 100 messages; C8 to 400,000 characters; E9 to 60 minutes; C6 to `oldest`.

**Kept, and why:**

- **Safety (rule 6):** every row in section I; A7 (secrets in chat); C15 (outside text stays marked as data); C16
  (one person's exchanges never reach another's run); E4, E8, E10, B1's cap and `AGENT_MAX_HOPS` (runaway loops and
  spend: with A1, B2 and E2 off, these are what stops a loop).
- **Delivery:** B8, B10, D10, D12 (nothing sent to an agent is lost, and it is told when a message didn't arrive).
- **Limits of the world:** B7's parking, B11, C6 in `oldest` mode, C7 (the provider or the plan refuses otherwise).
- **A person's own words:** A14, A15, C17's rules, D7 (they act only on what a person or the agent said).

**Inference:** with A1, B2 and E2 off, the only stops on a run that goes wrong are the step cap, the budget, the
stretch and hop limits and a person's Stop. That is the trade LJ asked for, but it should be tried first on one agent
(per-agent preset) before the server preset.

### Testing needs for this section

- `lslfControls`: unknown keys and bad values fall back to stock; `chosenAutonomy` keeps `lslf`; stock
  `autonomySettings` ignores it (rollback).
- Resolution order: agent `set` → agent preset → server preset → stock.
- A run records its resolved controls on its first `context` step, and a change mid-run doesn't alter it.
- For each control, the three cases from "Every switch's test": stock unchanged; steady (or `set`) removes the ability;
  another agent unaffected.
- For section I, a test that no control key can reach a safeguard (e.g. a `set` naming `approvals` is ignored).

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
- Is one control object in `agents.autonomy_brakes.lslf` (no migration) the right home, and is resolving it once per
  run enough for "stable at every step"?
- Is the `steady` preset's kept list right: anything kept that could go, or anything off that is a safeguard?
- Which abilities did the sweep miss?
