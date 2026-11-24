/**
 * An agent's wake controls (stored with its autonomy brakes, ADR 0131): an on/off switch and one switch per source of
 * wakes. Every control starts at the behaviour agents always had (on, every source on, mentions between agents
 * judged), so nothing changes until a person flips one. They only stop new runs: a message still lands, and a run
 * already going still reads what reaches it.
 */
import { type Executor, eq, type SQL, schema, sql } from "@agenteschat/db";
import { type AutonomySettings, autonomySettings } from "./autonomy-settings";

export { WAKE_WORD_LENGTH, WAKE_WORDS_MAX } from "./autonomy-settings";

const { agents } = schema;

/**
 * Where a wake comes from:
 * - `person`: a person's @mention or DM (and a person's message an agent answers without a mention: its work thread,
 *   its task's conversation).
 * - `agent_mention`: another agent's message that @mentions it.
 * - `router`: a message that names nobody, which the router gave it.
 * - `hand_off`: another agent's `ask_agent` or `tell_agent`, or a routine's `hand_off` report.
 * - `scheduled`: its own `follow_up`, reminders and routines.
 * - `words`: a message holding one of its wake words.
 * - `other`: anything else (a person's "Continuar", a released wait, a notice); only the on/off switch holds it.
 */
export type WakeSource = "person" | "agent_mention" | "router" | "hand_off" | "scheduled" | "words" | "other";

/** Whose messages its wake words count in. */
export type WakeWordsFrom = "people" | "agents" | "both";

/** Why the controls stop a wake: the agent is off, or that source's switch is. Null: it may wake. */
export function wakeRefusal(settings: AutonomySettings, source: WakeSource): "off" | "source" | null {
  if (!settings.on) return "off";
  const open =
    source === "person"
      ? settings.wakePeople
      : source === "agent_mention"
        ? settings.wakeAgents !== "off"
        : source === "router"
          ? settings.wakeRouter
          : source === "hand_off"
            ? settings.wakeHandOffs
            : source === "scheduled"
              ? settings.wakeScheduled
              : source === "words"
                ? settings.wakeWords.length > 0
                : true;
  return open ? null : "source";
}

/**
 * One line when a control stops a wake: the agent, the source and the message (or routine run) it came on. Never the
 * message's text.
 */
export function logWithheld(agentId: string, source: WakeSource, messageId: string | null, why: "off" | "source") {
  console.info(
    `[wake] withheld agent=${agentId} source=${source} message=${messageId ?? "-"} switch=${why === "off" ? "agent_off" : source}`,
  );
}

/** The agent's stored brakes read with the defaults (unknown agent: the defaults, so callers' own checks decide). */
async function settingsOf(db: Executor, agentId: string) {
  const [row] = await db.select({ brakes: agents.autonomyBrakes }).from(agents).where(eq(agents.id, agentId)).limit(1);
  return autonomySettings(row?.brakes);
}

/** Why the agent's controls stop a wake from `source` now (`wakeRefusal`), read from its stored brakes. */
export const wakeRefusalOf = async (db: Executor, agentId: string, source: WakeSource) =>
  wakeRefusal(await settingsOf(db, agentId), source);

/** Whether a wake from `source` may start a run of this agent; logs the line when it may not. */
export async function wakeAllowed(
  db: Executor,
  agentId: string,
  source: WakeSource,
  messageId: string | null,
): Promise<boolean> {
  const why = await wakeRefusalOf(db, agentId, source);
  if (why) logWithheld(agentId, source, messageId, why);
  return why === null;
}

/** `agentIds` the controls let wake from `source`, in order; each one stopped logs its line. */
export async function wakeFilter(
  db: Executor,
  agentIds: string[],
  source: WakeSource,
  messageId: string | null,
): Promise<string[]> {
  const out: string[] = [];
  for (const id of agentIds) if (await wakeAllowed(db, id, source, messageId)) out.push(id);
  return out;
}

/**
 * SQL: the agent whose stored brakes are `brakes` (its `autonomy_brakes` column) is on and its `key` switch is on.
 * Reads the stored jsonb as `autonomySettings` does: only a stored `false` turns a switch off. For the one statement
 * that writes a person's message and its runs (`insertMessageWithRuns`, `wakePeople`) and the router's candidates
 * (`wakeRouter`), which pick in SQL.
 */
export const wakeOpenSql = (brakes: SQL, key: "wakePeople" | "wakeRouter") =>
  sql`(coalesce(${brakes}->>'on', 'true') <> 'false' and coalesce(${brakes}->>${key}, 'true') <> 'false')`;

/** A wake word or phrase as a whole-word, case-blind pattern: "lead" matches "Lead," but not "leader". */
export function wakeWordPattern(word: string): RegExp | null {
  const w = word.trim();
  if (!w) return null;
  const escaped = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, "iu");
}

/** Whether `text` holds one of `words` as a whole word, ignoring capitals. */
export function holdsWakeWord(text: string, words: readonly string[]): boolean {
  for (const word of words) if (wakeWordPattern(word)?.test(text)) return true;
  return false;
}

/** Whether a message by a person (or an agent) counts for wake words set to `from`. */
export const wordsCountFrom = (from: WakeWordsFrom, author: "person" | "agent") =>
  from === "both" || (from === "people" ? author === "person" : author === "agent");
