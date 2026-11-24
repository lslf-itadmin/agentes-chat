/**
 * An agent's autonomy settings (ADR 0131), apart from the brakes so the prompt's team list reads them without the
 * engine's message paths.
 */

/** A costly step: opening a PR or MR, installing packages, a long run (`LONG_STEPS` tool calls and more). */
export type CostKind = "pr" | "install" | "long";
export const COST_KINDS: readonly CostKind[] = ["pr", "install", "long"];

/** Tool calls an unrequested run makes before going on needs a go (`long`). */
export const LONG_STEPS = 40;

export interface AutonomySettings {
  /** Costly work nobody asked for directly: `ask` proposes it first, `go` does it. */
  costly: "ask" | "go";
  /** Kinds a person said "always" to (no proposal) and "never" to (refused). */
  go: CostKind[];
  never: CostKind[];
  /** Unrequested runs it may have at once. */
  maxUnrequested: number;
  /** PRs its unrequested work may open in an hour. */
  maxPrsPerHour: number;
  /** Which agents it may wake or hand work to. */
  callAgents: "all" | "some" | "none";
  callAgentIds: string[];
  /** Its project (a repository, a product): agents of different projects don't call each other unless allowed. */
  project: string;
  otherProjects: boolean;
  /**
   * Wake controls (`wake-controls.ts`): `on` false starts no run of it from any source (messages are still kept);
   * each source has its own switch. Mentions by other agents: `judge` (a judge reads whether they ask it something),
   * `always` (naming its handle wakes it, no judge) or `off`. Wake words wake it as an @mention does, in messages of
   * `wakeWordsFrom`.
   */
  on: boolean;
  wakePeople: boolean;
  wakeAgents: "judge" | "always" | "off";
  wakeRouter: boolean;
  wakeHandOffs: boolean;
  wakeScheduled: boolean;
  wakeWords: string[];
  wakeWordsFrom: "people" | "agents" | "both";
  /**
   * Agentes' own interventions in its replies. `followThrough` false: no follow-through judge after its final answer
   * and no extra or nudge turns from the turn-end controller (`decideTurnEnd`); the reply is posted as written.
   */
  followThrough: boolean;
  /**
   * The move to background work (`works.ts`, ADR 0121). `workMove` false: a run of it stays in the conversation (no
   * automatic move, and `work_in_background` isn't offered). The automatic move comes after `workMoveAfterMin` minutes
   * of work, or `workMoveAfterCalls` model calls (`WORK_AUTO_AFTER_MS`, `WORK_AUTO_AFTER_CALLS`). `workCheckIns`
   * false: in its background work Agentes neither reminds it of a promised update nor posts one itself.
   */
  workMove: boolean;
  workMoveAfterMin: number;
  workMoveAfterCalls: number;
  workCheckIns: boolean;
}

/**
 * Open by default (agents act on their own and call each other, admins narrow it): costly work nobody asked for goes
 * ahead and any agent may call any other. Projects split agents only once a person sets them (`otherProjects` reads
 * only then). The caps on parallel unrequested runs and PRs an hour stay: they stop a runaway, they forbid nothing.
 */
export const AUTONOMY_DEFAULTS: AutonomySettings = {
  costly: "go",
  go: [],
  never: [],
  maxUnrequested: 2,
  maxPrsPerHour: 3,
  callAgents: "all",
  callAgentIds: [],
  project: "",
  otherProjects: false,
  on: true,
  wakePeople: true,
  wakeAgents: "judge",
  wakeRouter: true,
  wakeHandOffs: true,
  wakeScheduled: true,
  wakeWords: [],
  wakeWordsFrom: "people",
  followThrough: true,
  workMove: true,
  workMoveAfterMin: 4,
  workMoveAfterCalls: 20,
  workCheckIns: true,
};

/** The bounds of the automatic move's limits a person may set (minutes of work, model calls). */
export const WORK_MOVE_MINUTES = { min: 2, max: 120 } as const;
export const WORK_MOVE_CALLS = { min: 1, max: 500 } as const;

/** Wake words a list holds at most, and the length of each (`wake-controls.ts`). */
export const WAKE_WORDS_MAX = 50;
export const WAKE_WORD_LENGTH = 80;

/** Wake words as stored: strings, trimmed, one space inside, cut to length, the first of each ignoring capitals. */
function words(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of v) {
    if (typeof raw !== "string") continue;
    const w = raw.trim().replace(/\s+/g, " ").slice(0, WAKE_WORD_LENGTH);
    if (!w || seen.has(w.toLowerCase())) continue;
    seen.add(w.toLowerCase());
    out.push(w);
    if (out.length === WAKE_WORDS_MAX) break;
  }
  return out;
}

const kinds = (v: unknown) =>
  Array.isArray(v) ? [...new Set(v.filter((k): k is CostKind => COST_KINDS.includes(k as CostKind)))] : [];
const count = (v: unknown, min: number, max: number, fallback: number) =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : fallback;

/** An agent's stored `autonomy` read with the defaults; anything malformed is the default. */
export function autonomySettings(raw: unknown): AutonomySettings {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const d = AUTONOMY_DEFAULTS;
  return {
    costly: r.costly === "ask" ? "ask" : "go",
    go: kinds(r.go),
    never: kinds(r.never),
    maxUnrequested: count(r.maxUnrequested, 1, 20, d.maxUnrequested),
    maxPrsPerHour: count(r.maxPrsPerHour, 0, 50, d.maxPrsPerHour),
    callAgents: r.callAgents === "some" || r.callAgents === "none" ? r.callAgents : "all",
    callAgentIds: Array.isArray(r.callAgentIds)
      ? [...new Set(r.callAgentIds.filter((id): id is string => typeof id === "string"))].slice(0, 200)
      : [],
    project: typeof r.project === "string" ? r.project.trim().slice(0, 80) : "",
    otherProjects: r.otherProjects === true,
    on: r.on !== false,
    wakePeople: r.wakePeople !== false,
    wakeAgents: r.wakeAgents === "always" || r.wakeAgents === "off" ? r.wakeAgents : "judge",
    wakeRouter: r.wakeRouter !== false,
    wakeHandOffs: r.wakeHandOffs !== false,
    wakeScheduled: r.wakeScheduled !== false,
    wakeWords: words(r.wakeWords),
    wakeWordsFrom: r.wakeWordsFrom === "agents" || r.wakeWordsFrom === "both" ? r.wakeWordsFrom : "people",
    followThrough: r.followThrough !== false,
    workMove: r.workMove !== false,
    workMoveAfterMin: count(r.workMoveAfterMin, WORK_MOVE_MINUTES.min, WORK_MOVE_MINUTES.max, d.workMoveAfterMin),
    workMoveAfterCalls: count(r.workMoveAfterCalls, WORK_MOVE_CALLS.min, WORK_MOVE_CALLS.max, d.workMoveAfterCalls),
    workCheckIns: r.workCheckIns !== false,
  };
}

/**
 * What to store for settings a person set (`raw`): only the fields it holds, each normalized. A field nobody chose
 * stays out, so it follows `AUTONOMY_DEFAULTS` when they change instead of keeping the default of the day it was saved.
 */
export function chosenAutonomy(raw: Record<string, unknown>): Partial<AutonomySettings> {
  const all = autonomySettings(raw);
  return Object.fromEntries(Object.entries(all).filter(([k]) => raw[k] !== undefined));
}

/**
 * Whether two agents are a supervisor and its report, either way round ("Responde a", ADR 0148 addendum): they may
 * always call each other, whatever their lists say. Who may talk to an agent (its audience) still applies.
 */
export const inLine = (
  a: { id: string; reportsToAgentId?: string | null },
  b: { id: string; reportsToAgentId?: string | null },
) => a.reportsToAgentId === b.id || b.reportsToAgentId === a.id;

/** Whether an agent with `from` settings may wake or hand work to `to` (§8): its list, and other projects. */
export function mayCall(from: unknown, to: { id: string; autonomy: unknown }): boolean {
  const f = autonomySettings(from);
  if (f.callAgents === "none") return false;
  if (f.callAgents === "some" && !f.callAgentIds.includes(to.id)) return false;
  const t = autonomySettings(to.autonomy);
  return f.otherProjects || !f.project || !t.project || f.project === t.project;
}
