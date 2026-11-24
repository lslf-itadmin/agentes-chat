/**
 * Wake words (`wake-controls.ts`): a message holding one of an agent's words or phrases, as a whole word and ignoring
 * capitals, wakes that agent as an @mention does. Its `wakeWordsFrom` says whose messages count (people only by
 * default). Who may talk to it, the hop limit, the author's `callAgents` and, for a message nobody asked for directly,
 * the autonomy brakes (ADR 0131: `brakeWakes`) hold as for a mention.
 */
import type { PubSub } from "@agenteschat/adapters";
import { and, type Database, eq, inArray, isNull, schema, sql } from "@agenteschat/db";
import { autonomySettings } from "./autonomy-settings";
import { brakeWakes, callableAgents } from "./brakes";
import { createAgentRuns, eligibleChannelAgents, mentionRequester } from "./dispatch";
import { publishChannelEvent } from "./events";
import type { Judge } from "./judge";
import type { Message } from "./messages";
import { type AgentRun, replyThreadOf } from "./runs";
import { hopLimitReached } from "./stretch";
import { holdsWakeWord, wordsCountFrom } from "./wake-controls";

const { agents, agentRuns, channelMembers } = schema;

/**
 * The agents of the message's conversation whose wake words it holds, counting its author's kind: on, not its author,
 * not already @mentioned in it (the mention wakes them), and not running with it already (steered to their run).
 */
export async function wordWakeCandidates(db: Database, message: Message): Promise<string[]> {
  if (!message.body.trim()) return [];
  const rows = await db
    .select({ id: agents.id, brakes: agents.autonomyBrakes })
    .from(agents)
    .innerJoin(
      channelMembers,
      and(eq(channelMembers.agentId, agents.id), eq(channelMembers.channelId, message.channelId)),
    )
    .where(
      and(
        eq(agents.orgId, message.orgId),
        isNull(agents.archivedAt),
        sql`jsonb_typeof(${agents.autonomyBrakes}->'wakeWords') = 'array'`,
        sql`${agents.autonomyBrakes}->'wakeWords' <> '[]'::jsonb`,
      ),
    );
  if (rows.length === 0) return [];
  const author = message.authorType === "person" ? "person" : "agent";
  const steeredIds = Array.isArray(message.meta.steeredRunIds)
    ? message.meta.steeredRunIds.filter((v): v is string => typeof v === "string")
    : [];
  const steered = steeredIds.length
    ? new Set(
        (
          await db
            .select({ agentId: agentRuns.agentId })
            .from(agentRuns)
            .where(and(eq(agentRuns.orgId, message.orgId), inArray(agentRuns.id, steeredIds)))
        ).map((r) => r.agentId),
      )
    : new Set<string>();
  return rows
    .filter((r) => {
      if (r.id === message.authorAgentId || message.mentionedAgentIds.includes(r.id) || steered.has(r.id)) return false;
      const s = autonomySettings(r.brakes);
      return s.on && wordsCountFrom(s.wakeWordsFrom, author) && holdsWakeWord(message.body, s.wakeWords);
    })
    .map((r) => r.id);
}

/**
 * Starts (or joins) the runs of `agentIds` a message's wake words name, as a mention would: within the hop limit, only
 * agents its author may call (an agent's `callAgents`) and the person behind it may talk to. A message by an agent or a
 * routine goes through the brakes on unrequested work as an agent's mention does (`brakeWakes`: open work on the item
 * takes it, repeats stop, noise waits for the digest, an agent at its cap looks again later through `LATER_JOB`, and
 * each wake is recorded); `braked` says the brakes already let these agents through (that later look). Returns the new
 * runs.
 */
export async function startWordWakes(
  deps: { db: Database; pubsub?: PubSub; judge?: Judge | null },
  message: Message,
  agentIds: string[],
  options: { maxHops: number; braked?: boolean },
): Promise<AgentRun[]> {
  const { db } = deps;
  if (agentIds.length === 0 || (await hopLimitReached(db, message, options.maxHops))) return [];
  let ids = agentIds;
  if (message.authorAgentId) {
    const ok = await callableAgents(db, message.orgId, message.authorAgentId, ids);
    ids = ids.filter((id) => ok.has(id));
  }
  const eligible = await eligibleChannelAgents(db, message.orgId, message.channelId, ids, {
    requesterUserId: await mentionRequester(db, message),
  });
  if (eligible.length === 0) return [];
  const byPerson = message.authorType === "person";
  let wake = eligible.map((a) => a.id);
  if (!byPerson && !options.braked)
    wake = (await brakeWakes({ db, pubsub: deps.pubsub, judge: deps.judge ?? null }, message, wake)).wake;
  if (wake.length === 0) return [];
  const runs = await db.transaction((tx) =>
    createAgentRuns(
      tx,
      message,
      wake,
      "mention",
      byPerson ? { source: "words", joinChannelRun: true } : { source: "words", park: 1 },
    ),
  );
  for (const run of runs)
    await publishChannelEvent(deps.pubsub, {
      type: "agent.thinking",
      channelId: run.channelId,
      threadId: replyThreadOf(run),
      agentId: run.agentId,
      runId: run.id,
    }).catch(() => {});
  return runs;
}
