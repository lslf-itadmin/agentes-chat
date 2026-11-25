/**
 * Agent controls (ADR 0186): settings that narrow what the server does on an agent's behalf on its own (nudges,
 * judges, injected blocks, timers, learning), so an agent works in the same conditions at every step.
 *
 * This file is the foundation only: the controls, their stock values, the `steady` preset, the validator and the
 * resolver. No behaviour reads a control yet; each one is wired, with its own tests, by a later change. With nothing
 * set, and also with `steady` set, the server behaves as it did before this file.
 *
 * Where they live (no new column): an agent's own choice in `agents.autonomy_brakes.lslf`
 * (`{ preset?, set? }`), kept by `chosenAutonomy`; the server's default preset and the workspace-scope controls in
 * env vars (`LSLF_CONTROLS_PRESET`, `LSLF_CONTROLS_ORGS`, `LSLF_WORKSPACE_SET`).
 *
 * What is never a control: the safeguards (permission and run-policy checks, approval cards, budgets, the secret check
 * at a turn's end, delivery of work follow-ups, a wait detaching on a new message). No key here reaches them, and the
 * validator drops any key it doesn't know.
 */
import { and, asc, type Executor, eq, schema } from "@agenteschat/db";

/** A preset: `stock` is the server as it ships; `steady` narrows what the server does on its own. */
export type LslfPreset = "stock" | "steady";
export const LSLF_PRESETS: readonly LslfPreset[] = ["stock", "steady"];

/** Nudges at a turn's end that a control may turn off one by one. The secret check is not one of them. */
export type LslfNudgeKind =
  | "answer"
  | "decision"
  | "widget"
  | "openRequest"
  | "untried"
  | "unbacked"
  | "ask"
  | "findable"
  | "localPaths"
  | "toolNames"
  | "followThrough";
export const LSLF_NUDGE_KINDS: readonly LslfNudgeKind[] = [
  "answer",
  "decision",
  "widget",
  "openRequest",
  "untried",
  "unbacked",
  "ask",
  "findable",
  "localPaths",
  "toolNames",
  "followThrough",
];

/** Blocks the context builder adds to an agent's prompt that a control may leave out. */
export type LslfBlock =
  | "recentActions"
  | "workElsewhere"
  | "teammatesNow"
  | "alsoAnswering"
  | "parkedAsks"
  | "handedOff"
  | "waitingOnPerson"
  | "skills";
export const LSLF_BLOCKS: readonly LslfBlock[] = [
  "recentActions",
  "workElsewhere",
  "teammatesNow",
  "alsoAnswering",
  "parkedAsks",
  "handedOff",
  "waitingOnPerson",
  "skills",
];

/** Notice kinds (`notices.ts`) that may start a run of their own; any other joins the agent's next turn. */
export type LslfNoticeKind =
  | "routine_handoff"
  | "consult_reply"
  | "agent_note"
  | "wait_result"
  | "talker_reply"
  | "proposal_result"
  | "poll_result"
  | "follow_up"
  | "wake_skipped"
  | "work_check_in"
  | "run_stopped"
  | "github_event"
  | "work_follow_up";
export const LSLF_NOTICE_KINDS: readonly LslfNoticeKind[] = [
  "routine_handoff",
  "consult_reply",
  "agent_note",
  "wait_result",
  "talker_reply",
  "proposal_result",
  "poll_result",
  "follow_up",
  "wake_skipped",
  "work_check_in",
  "run_stopped",
  "github_event",
  "work_follow_up",
];

/**
 * One agent's controls. A `null` number or switch follows the server's own setting (an env var or a built-in value),
 * as it does today. Each key names the ability it governs; the change that wires it says where.
 */
export interface LslfAgentControls {
  /** Characters a single read returns before it is cut (files, pages, results). */
  readMaxChars: number;
  /** Messages in the history window; `null` = `AGENT_CONTEXT_MESSAGES`. */
  historyMessages: number | null;
  /** The window starts at an anchor message (a few under N) rather than exactly N back. */
  historyAnchor: boolean;
  /** Long old messages are shortened to their start, with a way to reopen them. */
  cutOld: boolean;
  /** "This turn" and current-line blocks are clipped. */
  turnClips: boolean;
  /** Old tool results are shortened before the window is full. */
  cutOldTools: boolean;
  /** How the context is made to fit the window: a judge picks, or the oldest results go first. */
  compaction: "judge" | "oldest";
  /** Injected blocks that reach the prompt. */
  blocks: "all" | LslfBlock[];
  /** The catch-up text after a pause. */
  catchUp: boolean;
  /** The judge that closes or releases parked asks after a pause. */
  catchUpTriage: boolean;
  /** Memory retrieval: as shipped (with its holdout), the same set every run, or none. */
  memory: "stock" | "fixed" | "off";
  /** Tool groups a judge picks per run, or every group listed. */
  toolLoading: "judge" | "all";
  /** Style and origin lines in the prompt (people's rules stay either way). */
  styleNotes: boolean;
  /** A turn's end: judged and nudged as shipped, or `plain` (only the secret check stays). */
  turnEnd: "stock" | "plain";
  /** Each nudge at a turn's end, under `turnEnd: "stock"`. */
  nudges: Record<LslfNudgeKind, boolean>;
  /** A run ending on a question holds its follow-ups until the answer. */
  askWaits: boolean;
  /** The `pass` tool and the "why you were called" lines, or one fixed line. */
  replyPolicy: "stock" | "plain";
  /** Text that only repeats a reaction is not posted. */
  dropRestated: boolean;
  /** The "wrap up" note near the step cap (the cap itself stays). */
  wrapUpNote: boolean;
  /** The stuck detector: ends the run, only notes it, or off (the step cap still ends it). */
  stuck: "stock" | "note" | "off";
  /** Long work moves to the background by itself; `null` = the server's own setting. */
  autoMove: boolean | null;
  /** The background-work tools and their check-ins and fallback updates. */
  workTools: boolean;
  /** Milliseconds a run waits for a burst of quick messages; `null` = the server's own wait. */
  burstWait: number | null;
  /** The "my AI provider isn't answering" posts (the parking itself stays). */
  outageText: boolean;
  /** The note that a run waits for its computer. */
  queueNote: boolean;
  /** A plan may move to another computer. */
  spill: boolean;
  /** An emoji stands in for a reply to "thanks". */
  socialReactions: boolean;
  /** A quick stand-in reply while a run is busy. */
  talker: boolean;
  /** A judge reads "stop" in chat as a stop (the Stop button stays). */
  stopJudge: boolean;
  /** A message sent mid-run is delivered into the running turn. */
  liveSteer: boolean;
  /** A judge reads whether a message ends a help card (the wait still detaches and the message is read). */
  waitJudge: "judge" | "off";
  /** Agents' replies to a mention wake the agent once, or once each. */
  mentionReport: "once" | "each";
  /** Unrequested items are triaged before they wake the agent. */
  triage: boolean;
  /** The same item twice starts one run. */
  dedupeItems: boolean;
  /** Runs agents may start on their own in one stretch (10 to 200). */
  stretchRuns: number;
  /** Minutes an ask to another agent stays out before it expires (15 to 1440). */
  consultTtlMin: number;
  /** The `follow_up` tool is offered (due follow-ups already set still deliver). */
  followUpTool: boolean;
  /** Notice kinds that may start a run; others join the next turn. */
  noticeWakes: "all" | LslfNoticeKind[];
  /** A mission with open items starts the next run by itself. */
  missionKeepGoing: boolean;
  /** The agent learns from its own turns. */
  learn: boolean;
  /** A reaction on its reply changes its memory. */
  feedbackLearning: boolean;
  /** Its status line is picked by a judge, or plain. */
  statusLine: "judge" | "plain";
  /** `To:` and `CC:` lines in its messages mention the agents named. */
  nameMentions: boolean;
  /** A prompt line lists the conversation members' handles. */
  handlesLine: boolean;
  /** A thread run sees the channel's files and the agent's reports. */
  threadSharesChannel: boolean;
}
export type LslfAgentKey = keyof LslfAgentControls;

/** Controls whose work is a workspace's, not one agent's: resolved per workspace, from env vars only. */
export interface LslfWorkspaceControls {
  /** Threads are reflected into shared memory. */
  reflect: boolean;
  /** Thread and period summaries are written. */
  summaries: boolean;
  /** Memory decays and is archived by the daily job. */
  memoryUpkeep: boolean;
  /** Memory items are merged and superseded. */
  memoryMerge: boolean;
  /** Learned skills are promoted, shared and decayed. */
  skillUpkeep: boolean;
  /** A judge assesses threads (titles and state). */
  threadAssess: boolean;
  /** Vault connections sync on their own (a person's sync stays). */
  vaultSync: boolean;
}
export type LslfWorkspaceKey = keyof LslfWorkspaceControls;

const allNudges = (on: boolean) =>
  Object.fromEntries(LSLF_NUDGE_KINDS.map((k) => [k, on])) as Record<LslfNudgeKind, boolean>;

/** The server as it ships: every control at the value that is today's behaviour. */
export const STOCK_AGENT_CONTROLS: Readonly<LslfAgentControls> = Object.freeze({
  readMaxChars: 40_000,
  historyMessages: null,
  historyAnchor: true,
  cutOld: true,
  turnClips: true,
  cutOldTools: true,
  compaction: "judge",
  blocks: "all",
  catchUp: true,
  catchUpTriage: true,
  memory: "stock",
  toolLoading: "judge",
  styleNotes: true,
  turnEnd: "stock",
  nudges: allNudges(true),
  askWaits: true,
  replyPolicy: "stock",
  dropRestated: true,
  wrapUpNote: true,
  stuck: "stock",
  autoMove: null,
  workTools: true,
  burstWait: null,
  outageText: true,
  queueNote: true,
  spill: true,
  socialReactions: true,
  talker: true,
  stopJudge: true,
  liveSteer: true,
  waitJudge: "judge",
  mentionReport: "once",
  triage: true,
  dedupeItems: true,
  stretchRuns: 50,
  consultTtlMin: 15,
  followUpTool: true,
  noticeWakes: "all",
  missionKeepGoing: true,
  learn: true,
  feedbackLearning: true,
  statusLine: "judge",
  nameMentions: false,
  handlesLine: false,
  threadSharesChannel: false,
} satisfies LslfAgentControls);

/**
 * `steady`: the server stops acting on its own where it safely can, and the agent receives more of the conversation
 * whole. The nudges stay at stock here because `turnEnd: "plain"` already leaves only the secret check.
 */
export const STEADY_AGENT_CONTROLS: Readonly<LslfAgentControls> = Object.freeze({
  ...STOCK_AGENT_CONTROLS,
  readMaxChars: 400_000,
  historyMessages: 100,
  historyAnchor: false,
  cutOld: false,
  turnClips: false,
  cutOldTools: false,
  compaction: "oldest",
  blocks: ["handedOff", "waitingOnPerson", "skills"],
  catchUp: false,
  catchUpTriage: false,
  memory: "fixed",
  toolLoading: "all",
  turnEnd: "plain",
  replyPolicy: "plain",
  dropRestated: false,
  wrapUpNote: false,
  stuck: "off",
  autoMove: false,
  workTools: false,
  outageText: false,
  queueNote: false,
  socialReactions: false,
  talker: false,
  waitJudge: "off",
  triage: false,
  consultTtlMin: 60,
  followUpTool: false,
  noticeWakes: ["routine_handoff", "consult_reply", "wait_result", "proposal_result", "poll_result", "work_follow_up"],
  missionKeepGoing: false,
  learn: false,
  feedbackLearning: false,
  statusLine: "plain",
  handlesLine: true,
  threadSharesChannel: true,
} satisfies LslfAgentControls);

export const STOCK_WORKSPACE_CONTROLS: Readonly<LslfWorkspaceControls> = Object.freeze({
  reflect: true,
  summaries: true,
  memoryUpkeep: true,
  memoryMerge: true,
  skillUpkeep: true,
  threadAssess: true,
  vaultSync: true,
});

export const STEADY_WORKSPACE_CONTROLS: Readonly<LslfWorkspaceControls> = Object.freeze({
  reflect: false,
  summaries: false,
  memoryUpkeep: false,
  memoryMerge: false,
  skillUpkeep: false,
  threadAssess: false,
  vaultSync: true,
});

export const AGENT_PRESETS: Readonly<Record<LslfPreset, Readonly<LslfAgentControls>>> = {
  stock: STOCK_AGENT_CONTROLS,
  steady: STEADY_AGENT_CONTROLS,
};
export const WORKSPACE_PRESETS: Readonly<Record<LslfPreset, Readonly<LslfWorkspaceControls>>> = {
  stock: STOCK_WORKSPACE_CONTROLS,
  steady: STEADY_WORKSPACE_CONTROLS,
};

export const LSLF_AGENT_KEYS = Object.keys(STOCK_AGENT_CONTROLS) as LslfAgentKey[];
export const LSLF_WORKSPACE_KEYS = Object.keys(STOCK_WORKSPACE_CONTROLS) as LslfWorkspaceKey[];

/** An agent's controls as stored: a preset, and keys set one by one. */
export interface LslfStored {
  preset?: LslfPreset;
  /** `nudges` is stored as the kinds set, each over the preset's value. */
  set?: Partial<Omit<LslfAgentControls, "nudges">> & { nudges?: Partial<Record<LslfNudgeKind, boolean>> };
}

/** `undefined` = the value is refused (dropped), so the key follows the layer below. */
type Check = (v: unknown) => unknown;

const bool: Check = (v) => (typeof v === "boolean" ? v : undefined);
const oneOf =
  <T extends string>(...values: T[]): Check =>
  (v) =>
    typeof v === "string" && (values as string[]).includes(v) ? v : undefined;
/** A whole number in range; out of range is refused, not clamped, so a typo never becomes an extreme. */
const int =
  (min: number, max: number): Check =>
  (v) =>
    typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : undefined;
const orNull =
  (check: Check): Check =>
  (v) =>
    v === null ? null : check(v);
/** `"all"`, or a list of known names (unknown names dropped, each once). */
const allOr =
  (known: readonly string[]): Check =>
  (v) => {
    if (v === "all") return "all";
    if (!Array.isArray(v)) return undefined;
    return [...new Set(v.filter((x): x is string => typeof x === "string" && known.includes(x)))];
  };
const nudgeMap: Check = (v) => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const out = Object.fromEntries(
    Object.entries(v).filter(([k, on]) => LSLF_NUDGE_KINDS.includes(k as LslfNudgeKind) && typeof on === "boolean"),
  );
  return Object.keys(out).length > 0 ? out : undefined;
};

const AGENT_CHECKS: Record<LslfAgentKey, Check> = {
  readMaxChars: int(1_000, 400_000),
  historyMessages: orNull(int(1, 500)),
  historyAnchor: bool,
  cutOld: bool,
  turnClips: bool,
  cutOldTools: bool,
  compaction: oneOf("judge", "oldest"),
  blocks: allOr(LSLF_BLOCKS),
  catchUp: bool,
  catchUpTriage: bool,
  memory: oneOf("stock", "fixed", "off"),
  toolLoading: oneOf("judge", "all"),
  styleNotes: bool,
  turnEnd: oneOf("stock", "plain"),
  nudges: nudgeMap,
  askWaits: bool,
  replyPolicy: oneOf("stock", "plain"),
  dropRestated: bool,
  wrapUpNote: bool,
  stuck: oneOf("stock", "note", "off"),
  autoMove: orNull(bool),
  workTools: bool,
  burstWait: orNull(int(0, 10_000)),
  outageText: bool,
  queueNote: bool,
  spill: bool,
  socialReactions: bool,
  talker: bool,
  stopJudge: bool,
  liveSteer: bool,
  waitJudge: oneOf("judge", "off"),
  mentionReport: oneOf("once", "each"),
  triage: bool,
  dedupeItems: bool,
  stretchRuns: int(10, 200),
  consultTtlMin: int(15, 1440),
  followUpTool: bool,
  noticeWakes: allOr(LSLF_NOTICE_KINDS),
  missionKeepGoing: bool,
  learn: bool,
  feedbackLearning: bool,
  statusLine: oneOf("judge", "plain"),
  nameMentions: bool,
  handlesLine: bool,
  threadSharesChannel: bool,
};

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * An agent's stored controls (`autonomy_brakes.lslf`), normalized: an unknown preset or key is dropped, and so is a
 * value of the wrong kind or out of range, so that key follows the layer below. Nothing else is kept.
 */
export function lslfControls(raw: unknown): LslfStored {
  if (!isRecord(raw)) return {};
  const out: LslfStored = {};
  if (typeof raw.preset === "string" && LSLF_PRESETS.includes(raw.preset as LslfPreset))
    out.preset = raw.preset as LslfPreset;
  if (isRecord(raw.set)) {
    const set: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(raw.set)) {
      if (!Object.hasOwn(AGENT_CHECKS, key)) continue;
      const ok = AGENT_CHECKS[key as LslfAgentKey](value);
      if (ok !== undefined) set[key] = ok;
    }
    if (Object.keys(set).length > 0) out.set = set as LslfStored["set"];
  }
  return out;
}

/** What the server's env vars say (`LSLF_CONTROLS_PRESET`, `LSLF_CONTROLS_ORGS`, `LSLF_WORKSPACE_SET`). */
export interface LslfServerSettings {
  /** The default preset of every agent (and workspace) it applies to. */
  preset: LslfPreset;
  /** The workspaces the server's preset and workspace set apply to; `null` = every workspace. */
  orgs: readonly string[] | null;
  /** Workspace-scope controls set one by one, over the server's preset. */
  workspaceSet: Partial<LslfWorkspaceControls>;
}

export const STOCK_SERVER_SETTINGS: LslfServerSettings = Object.freeze({
  preset: "stock",
  orgs: null,
  workspaceSet: Object.freeze({}),
});

/**
 * `LSLF_WORKSPACE_SET` read: `key=on|off` pairs separated by commas. A key that isn't a workspace control, or a value
 * other than on/off (true/false), is ignored, so the key stays at the preset's value.
 */
export function parseWorkspaceSet(raw: string | undefined): Partial<LslfWorkspaceControls> {
  const out: Partial<LslfWorkspaceControls> = {};
  for (const pair of (raw ?? "").split(",")) {
    const at = pair.indexOf("=");
    if (at < 0) continue;
    const key = pair.slice(0, at).trim() as LslfWorkspaceKey;
    const value = pair
      .slice(at + 1)
      .trim()
      .toLowerCase();
    if (!LSLF_WORKSPACE_KEYS.includes(key)) continue;
    if (value === "on" || value === "true") out[key] = true;
    else if (value === "off" || value === "false") out[key] = false;
  }
  return out;
}

/** The server's settings from its config values. */
export function lslfServerSettings(env: {
  preset?: string;
  orgs?: readonly string[] | null;
  workspaceSet?: string;
}): LslfServerSettings {
  const orgs = env.orgs?.map((o) => o.trim()).filter(Boolean) ?? [];
  return {
    preset: env.preset === "steady" ? "steady" : "stock",
    orgs: orgs.length > 0 ? orgs : null,
    workspaceSet: parseWorkspaceSet(env.workspaceSet),
  };
}

/** Whether the server's preset and workspace set apply to a workspace. */
const serverApplies = (server: LslfServerSettings, orgId: string) => !server.orgs || server.orgs.includes(orgId);

/** Where a resolved value came from, most specific first. */
export type LslfSource = "set" | "agent" | "server" | "stock";

/** An agent's controls for one run, and what decided them. */
export interface ResolvedAgentControls {
  /** The preset the values start from: the agent's, else the server's (where it applies), else stock. */
  preset: LslfPreset;
  /** Where that preset came from. */
  presetFrom: Exclude<LslfSource, "set">;
  /** Keys the agent set one by one. */
  set: LslfAgentKey[];
  controls: LslfAgentControls;
}

/**
 * An agent's controls, most specific first: the agent's `set` → the agent's `preset` → `LSLF_CONTROLS_PRESET` (when
 * `LSLF_CONTROLS_ORGS` is unset or names the workspace) → stock. `brakes` is the agent's stored `autonomy_brakes`;
 * one without an `lslf` key (any agent saved before controls existed) resolves to stock.
 */
export function resolveAgentControls(
  brakes: unknown,
  orgId: string,
  server: LslfServerSettings = STOCK_SERVER_SETTINGS,
): ResolvedAgentControls {
  const stored = lslfControls(isRecord(brakes) ? brakes.lslf : undefined);
  const fromServer = serverApplies(server, orgId) && server.preset !== "stock";
  const preset: LslfPreset = stored.preset ?? (fromServer ? server.preset : "stock");
  const presetFrom: ResolvedAgentControls["presetFrom"] = stored.preset ? "agent" : fromServer ? "server" : "stock";
  const base = AGENT_PRESETS[preset];
  const { nudges, ...rest } = stored.set ?? {};
  const merged = { ...base, ...rest };
  // Lists are copied so a caller never holds the preset's own array.
  const controls: LslfAgentControls = {
    ...merged,
    nudges: { ...base.nudges, ...nudges },
    blocks: merged.blocks === "all" ? "all" : [...merged.blocks],
    noticeWakes: merged.noticeWakes === "all" ? "all" : [...merged.noticeWakes],
  };
  return { preset, presetFrom, set: Object.keys(stored.set ?? {}) as LslfAgentKey[], controls };
}

/**
 * A workspace's controls, resolved where its job is queued and again where it runs: `LSLF_WORKSPACE_SET` →
 * `LSLF_CONTROLS_PRESET` → stock, both only where `LSLF_CONTROLS_ORGS` is unset or names the workspace.
 */
export function resolveWorkspaceControls(
  orgId: string,
  server: LslfServerSettings = STOCK_SERVER_SETTINGS,
): LslfWorkspaceControls {
  if (!serverApplies(server, orgId)) return { ...STOCK_WORKSPACE_CONTROLS };
  return { ...WORKSPACE_PRESETS[server.preset], ...server.workspaceSet };
}

/** The key a run's first `context` step records its controls under. */
export const RUN_CONTROLS_STEP_KEY = "lslf";

/**
 * The controls a run started with, as its `context` step recorded them, so every later turn of that run reads the
 * same ones whatever changes meanwhile. `null`: the run recorded none (it started before controls existed).
 */
export async function runControls(
  db: Executor,
  run: { id: string; orgId: string },
): Promise<ResolvedAgentControls | null> {
  const steps = await db
    .select({ data: schema.agentRunSteps.data })
    .from(schema.agentRunSteps)
    .where(
      and(
        eq(schema.agentRunSteps.orgId, run.orgId),
        eq(schema.agentRunSteps.runId, run.id),
        eq(schema.agentRunSteps.kind, "context"),
      ),
    )
    .orderBy(asc(schema.agentRunSteps.seq));
  for (const s of steps) {
    const recorded = (s.data as Record<string, unknown> | null)?.[RUN_CONTROLS_STEP_KEY];
    if (recorded) return recorded as ResolvedAgentControls;
  }
  return null;
}
