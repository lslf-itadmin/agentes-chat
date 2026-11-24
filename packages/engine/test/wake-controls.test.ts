import { afterEach, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { asc, eq, schema } from "@agenteschat/db";
import {
  AUTONOMY_DEFAULTS,
  autonomySettings,
  createAgent,
  createAgentRuns,
  createLlmRouterStrategy,
  drainOutbox,
  getAgent,
  getMessage,
  holdsWakeWord,
  insertMessage,
  openDm,
  postPersonMessage,
  routeMessage,
  startOrJoinRun,
  updateAgent,
  wakeRefusal,
  wordsCountFrom,
} from "../src";
import { deliverNotice } from "../src/delivery";
import { type Fixture, setup } from "./fixtures";
import { channelRoutine, fire, minutesFromNow } from "./routine-fixtures";

/**
 * An agent's wake controls (`wake-controls.ts`): on/off and one switch per source of wakes, stored with its autonomy
 * brakes. Untouched, they change nothing; off, no run of the agent starts from any source while its messages stay; a
 * source switched off starts nothing from that source alone. Mentions by other agents may skip the judge ("always"),
 * and wake words wake the agent as an @mention does.
 */

setDefaultTimeout(60_000);

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const setBrakes = (agentId: string, brakes: Record<string, unknown>) =>
  f.db.update(schema.agents).set({ autonomyBrakes: brakes }).where(eq(schema.agents.id, agentId));
const ask = (body: string, channelId = f.general.id) =>
  postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, channelId, { body });
const runsOf = (agentId: string) =>
  f.db
    .select()
    .from(schema.agentRuns)
    .where(eq(schema.agentRuns.agentId, agentId))
    .orderBy(asc(schema.agentRuns.createdAt));
const messagesIn = (channelId: string) =>
  f.db.select().from(schema.messages).where(eq(schema.messages.channelId, channelId));
async function agentInGeneral(name: string, handle: string) {
  const created = await createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    { name, handle, role: "Revisão", credentialId: f.credential.id },
    { model: "claude-sonnet-5-5" },
  );
  await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: f.general.id, agentId: created.id });
  return created;
}
/** The one line a control logs when it stops a wake (`logWithheld`). */
function captureLog() {
  const lines: string[] = [];
  const spy = spyOn(console, "info").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  return { lines, restore: () => spy.mockRestore() };
}

describe("the settings", () => {
  test("untouched, every control is today's behaviour", () => {
    const s = autonomySettings({});
    expect(s).toMatchObject({
      on: true,
      wakePeople: true,
      wakeAgents: "judge",
      wakeRouter: true,
      wakeHandOffs: true,
      wakeScheduled: true,
      wakeWords: [],
      wakeWordsFrom: "people",
    });
    expect(s).toEqual(AUTONOMY_DEFAULTS);
    for (const source of ["person", "agent_mention", "router", "hand_off", "scheduled", "other"] as const)
      expect(wakeRefusal(s, source)).toBeNull();
  });

  test("only a stored false turns a switch off; malformed values read as the defaults", () => {
    const s = autonomySettings({ on: "no", wakePeople: 0, wakeAgents: "sometimes", wakeWordsFrom: "robots" });
    expect(s).toMatchObject({ on: true, wakePeople: true, wakeAgents: "judge", wakeWordsFrom: "people" });
    expect(autonomySettings({ on: false }).on).toBe(false);
  });

  test("wake words are trimmed, de-duplicated ignoring capitals, and capped", () => {
    const s = autonomySettings({ wakeWords: ["  Invoice ", "invoice", "", 7, "contract   review", "x".repeat(200)] });
    expect(s.wakeWords).toEqual(["Invoice", "contract review", "x".repeat(80)]);
    expect(autonomySettings({ wakeWords: Array.from({ length: 80 }, (_, i) => `w${i}`) }).wakeWords).toHaveLength(50);
  });

  test("off refuses every source; a source switched off refuses that source alone", () => {
    const off = autonomySettings({ on: false });
    for (const source of ["person", "agent_mention", "router", "hand_off", "scheduled", "words", "other"] as const)
      expect(wakeRefusal(off, source)).toBe("off");
    const quiet = autonomySettings({ wakeRouter: false, wakeAgents: "off" });
    expect(wakeRefusal(quiet, "router")).toBe("source");
    expect(wakeRefusal(quiet, "agent_mention")).toBe("source");
    expect(wakeRefusal(quiet, "person")).toBeNull();
    expect(wakeRefusal(autonomySettings({ wakeAgents: "always" }), "agent_mention")).toBeNull();
  });

  test("a wake word matches as a whole word, ignoring capitals; a phrase across any spacing", () => {
    expect(holdsWakeWord("Can someone check the INVOICE?", ["invoice"])).toBe(true);
    expect(holdsWakeWord("Three invoices came in", ["invoice"])).toBe(false);
    expect(holdsWakeWord("our leader said so", ["lead"])).toBe(false);
    expect(holdsWakeWord("Need a contract\nreview today", ["contract review"])).toBe(true);
    expect(holdsWakeWord("price is $5 (approx.)", ["(approx.)"])).toBe(true);
    expect(holdsWakeWord("Revisão do contrato", ["revisão"])).toBe(true);
    expect(holdsWakeWord("anything", [])).toBe(false);
    expect(wordsCountFrom("people", "person")).toBe(true);
    expect(wordsCountFrom("people", "agent")).toBe(false);
    expect(wordsCountFrom("agents", "agent")).toBe(true);
    expect(wordsCountFrom("both", "agent")).toBe(true);
  });

  test("saved through updateAgent: only the fields given are stored, the rest stay", async () => {
    f = await setup();
    await updateAgent(f.db, f.owner.id, f.org.id, f.agent.id, { autonomyBrakes: { wakeRouter: false } });
    await updateAgent(f.db, f.owner.id, f.org.id, f.agent.id, { autonomyBrakes: { wakeWords: ["Invoice"] } });
    const stored = (await getAgent(f.db, f.org.id, f.agent.id))?.autonomyBrakes;
    expect(stored).toEqual({ wakeRouter: false, wakeWords: ["Invoice"] });
  });
});

describe("on/off", () => {
  test("off: a person's @mention and DM start no run, the messages stay, one line is logged; on again wakes it", async () => {
    f = await setup({ reply: () => ({ chunks: ["Feito."] }) });
    await setBrakes(f.agent.id, { on: false });
    const log = captureLog();
    try {
      const mention = await ask("@dev can you look at this?");
      const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
      const direct = await ask("hello there", dm.id);
      await drainOutbox(f.db, f.handlers);
      expect(await runsOf(f.agent.id)).toHaveLength(0);
      expect((await messagesIn(f.general.id)).map((m) => m.id)).toContain(mention.id);
      expect((await messagesIn(dm.id)).map((m) => m.id)).toContain(direct.id);
      const line = log.lines.find((l) => l.includes(`message=${mention.id}`));
      expect(line).toBe(`[wake] withheld agent=${f.agent.id} source=person message=${mention.id} switch=agent_off`);
      // Never the message's text.
      expect(log.lines.join("\n")).not.toContain("look at this");
    } finally {
      log.restore();
    }
    await setBrakes(f.agent.id, {});
    await ask("@dev and now?");
    expect(await runsOf(f.agent.id)).toHaveLength(1);
  });

  test("off: every other path into startOrJoinRun starts nothing (router, hand-off, routine, notices, other)", async () => {
    f = await setup();
    await setBrakes(f.agent.id, { on: false });
    const log = captureLog();
    try {
      const m = await insertMessage(f.db, {
        orgId: f.org.id,
        channelId: f.general.id,
        author: { type: "person", userId: f.owner.id },
        body: "anyone",
      });
      for (const source of ["router", "hand_off", "scheduled", "words", "other", undefined] as const)
        expect(
          await f.db.transaction((tx) => createAgentRuns(tx, m, [f.agent.id], "router", source ? { source } : {})),
        ).toEqual([]);
      const delivered = await f.db.transaction((tx) =>
        deliverNotice(tx, {
          orgId: f.org.id,
          agentId: f.agent.id,
          channelId: f.general.id,
          threadId: null,
          hop: 0,
          stretchId: null,
          notice: { kind: "follow_up", text: "time to check" },
        }),
      );
      expect(delivered.runs).toEqual([]);
      expect(await runsOf(f.agent.id)).toHaveLength(0);
    } finally {
      log.restore();
    }
  });
});

describe("each source on its own", () => {
  test("people off: a person's mention starts nothing, but a hand-off still does", async () => {
    f = await setup();
    await setBrakes(f.agent.id, { wakePeople: false });
    const log = captureLog();
    try {
      const view = await ask("@dev please check");
      expect(await runsOf(f.agent.id)).toHaveLength(0);
      const m = await getMessage(f.db, f.org.id, view.id);
      if (!m) throw new Error("no message");
      expect(log.lines).toContain(`[wake] withheld agent=${f.agent.id} source=person message=${m.id} switch=person`);
      const started = await f.db.transaction((tx) => startOrJoinRun(tx, m, f.agent.id, "dm", { source: "hand_off" }));
      expect(started && "created" in started).toBe(true);
    } finally {
      log.restore();
    }
  });

  test("router, hand-offs and scheduled wakes each stop only their own source", async () => {
    f = await setup();
    const m = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "person", userId: f.owner.id },
      body: "names nobody",
    });
    const log = captureLog();
    try {
      for (const [key, source] of [
        ["wakeRouter", "router"],
        ["wakeHandOffs", "hand_off"],
        ["wakeScheduled", "scheduled"],
      ] as const) {
        await setBrakes(f.agent.id, { [key]: false });
        expect(await f.db.transaction((tx) => createAgentRuns(tx, m, [f.agent.id], "router", { source }))).toEqual([]);
        expect(log.lines.at(-1)).toBe(
          `[wake] withheld agent=${f.agent.id} source=${source} message=${m.id} switch=${source}`,
        );
      }
      // A follow-up is a scheduled wake: with scheduled wakes off, its notice is written and wakes nothing.
      const followUp = await f.db.transaction((tx) =>
        deliverNotice(tx, {
          orgId: f.org.id,
          agentId: f.agent.id,
          channelId: f.general.id,
          threadId: null,
          hop: 0,
          stretchId: null,
          notice: { kind: "follow_up", text: "time to check" },
        }),
      );
      expect(followUp.runs).toEqual([]);
      // Untouched sources still start a run.
      const other = await f.db.transaction((tx) => createAgentRuns(tx, m, [f.agent.id], "mention", {}));
      expect(other).toHaveLength(1);
    } finally {
      log.restore();
    }
  });

  test("router off: the router never offers the agent as a candidate", async () => {
    f = await setup();
    await setBrakes(f.agent.id, { wakeRouter: false });
    const strategy = createLlmRouterStrategy({ gateway: f.gateway, resolveModel: async () => "claude-haiku-5-5" });
    const m = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "person", userId: f.owner.id },
      body: "does anyone know?",
    });
    const res = await routeMessage(
      { db: f.db, strategy, policy: { minScore: 0.5, maxAgents: 2, maxHops: 3 } },
      { orgId: f.org.id, messageId: m.id },
    );
    // Only #general's one agent, switched off for the router: nobody to pick.
    expect(res).toMatchObject({ runs: [], skipped: "no_candidates" });
  });
});

describe("another agent's @mention", () => {
  async function chain(judgeNothing: number) {
    f = await setup({
      judge: (kind) => (kind === "mention_needs_nothing" ? judgeNothing : undefined),
      reply: () => ({ chunks: ["Feito."] }),
    });
    const qa = await agentInGeneral("QA", "qa");
    await ask("@dev cuida disso com o QA");
    const [devRun] = await runsOf(f.agent.id);
    if (!devRun) throw new Error("no run");
    const post = (body: string) =>
      insertMessage(f.db, {
        orgId: f.org.id,
        channelId: f.general.id,
        author: { type: "agent", agentId: f.agent.id, runId: devRun.id, hop: 1 },
        body,
      });
    return { qa, post };
  }

  test("untouched: the judge still decides (a message it reads as asking nothing doesn't wake)", async () => {
    const { qa, post } = await chain(0.95);
    await post("Como o @qa disse, está certo.");
    await drainOutbox(f.db, f.handlers);
    expect(await runsOf(qa.id)).toHaveLength(0);
  });

  test("always: naming its handle wakes it with no judge", async () => {
    const { qa, post } = await chain(0.95);
    await setBrakes(qa.id, { wakeAgents: "always" });
    const m = await post("Como o @qa disse, está certo.");
    await drainOutbox(f.db, f.handlers);
    const runs = await runsOf(qa.id);
    expect(runs.map((r) => r.triggerMessageId)).toContain(m.id);
    const [decision] = await f.db
      .select()
      .from(schema.routingDecisions)
      .where(eq(schema.routingDecisions.messageId, m.id));
    expect(decision?.selectedAgentIds).toEqual([qa.id]);
  });

  test("always still respects the author's callAgents", async () => {
    const { qa, post } = await chain(0.95);
    await setBrakes(qa.id, { wakeAgents: "always" });
    await setBrakes(f.agent.id, { callAgents: "none" });
    await post("@qa revisa isso.");
    await drainOutbox(f.db, f.handlers);
    expect(await runsOf(qa.id)).toHaveLength(0);
  });

  test("off: even a plain request starts nothing, and the line says why", async () => {
    const { qa, post } = await chain(0.01);
    await setBrakes(qa.id, { wakeAgents: "off" });
    const log = captureLog();
    try {
      const m = await post("@qa revisa o PR #12 por favor.");
      await drainOutbox(f.db, f.handlers);
      expect(await runsOf(qa.id)).toHaveLength(0);
      expect(log.lines).toContain(
        `[wake] withheld agent=${qa.id} source=agent_mention message=${m.id} switch=agent_mention`,
      );
    } finally {
      log.restore();
    }
  });
});

describe("wake words", () => {
  test("a person's message holding a word wakes the agent like a mention; a longer word doesn't", async () => {
    f = await setup({ reply: () => ({ chunks: ["Feito."] }) });
    const qa = await agentInGeneral("QA", "qa");
    await setBrakes(qa.id, { wakeWords: ["invoice", "contract review"] });
    const miss = await ask("three invoices came in");
    await drainOutbox(f.db, f.handlers);
    expect((await runsOf(qa.id)).map((r) => r.triggerMessageId)).not.toContain(miss.id);
    const hit = await ask("Who can take the Contract Review today?");
    await drainOutbox(f.db, f.handlers);
    const run = (await runsOf(qa.id)).find((r) => r.triggerMessageId === hit.id);
    expect(run).toMatchObject({ trigger: "mention" });
  });

  test("by default an agent's message doesn't count; set to agents or both, it does", async () => {
    f = await setup({ reply: () => ({ chunks: ["Feito."] }) });
    const qa = await agentInGeneral("QA", "qa");
    await setBrakes(qa.id, { wakeWords: ["invoice"] });
    const byAgent = (body: string) =>
      insertMessage(f.db, {
        orgId: f.org.id,
        channelId: f.general.id,
        author: { type: "agent", agentId: f.agent.id, runId: null, hop: 1, stretchId: null },
        body,
      });
    const first = await byAgent("the invoice is ready");
    await drainOutbox(f.db, f.handlers);
    expect((await runsOf(qa.id)).map((r) => r.triggerMessageId)).not.toContain(first.id);
    await setBrakes(qa.id, { wakeWords: ["invoice"], wakeWordsFrom: "both" });
    const second = await byAgent("another invoice is ready");
    await drainOutbox(f.db, f.handlers);
    expect((await runsOf(qa.id)).map((r) => r.triggerMessageId)).toContain(second.id);
  });

  /** An unattended agent's message (no run, no person behind it): work nobody asked for, so the brakes hold. */
  const unattended = (body: string) =>
    insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "agent", agentId: f.agent.id, runId: null, hop: 1, stretchId: null },
      body,
    });
  /** One job's handler alone: draining would also run the woken agents and end their runs. */
  const runJob = (kind: string, payload: Record<string, unknown>) =>
    f.handlers[kind]?.({ id: kind, orgId: f.org.id, kind, payload } as never, { finalAttempt: false });
  const signalsOf = (agentId: string) =>
    f.db.select().from(schema.autonomySignals).where(eq(schema.autonomySignals.agentId, agentId));

  test("an unattended agent's message holding a word meets the brakes: noise goes to the digest, no run", async () => {
    f = await setup({
      judge: (kind) => (kind === "alert_triage" ? "noise" : undefined),
      reply: () => ({ chunks: ["Feito."] }),
    });
    const qa = await agentInGeneral("QA", "qa");
    await setBrakes(qa.id, { wakeWords: ["invoice"], wakeWordsFrom: "agents" });
    const m = await unattended("the invoice sync timed out again");
    await drainOutbox(f.db, f.handlers);
    expect((await runsOf(qa.id)).map((r) => r.triggerMessageId)).not.toContain(m.id);
    expect((await signalsOf(qa.id)).map((s) => [s.kind, s.messageId])).toEqual([["digest", m.id]]);
  });

  test("an unattended wake word at the agent's cap looks again later; work it lets through is recorded as a wake", async () => {
    f = await setup({ reply: () => ({ chunks: ["Feito."] }) });
    const qa = await agentInGeneral("QA", "qa");
    await setBrakes(qa.id, { wakeWords: ["invoice"], wakeWordsFrom: "both", maxUnrequested: 1 });
    const first = await unattended("the invoice import failed");
    await runJob("message.posted", { messageId: first.id });
    const [run] = await runsOf(qa.id);
    expect(run?.triggerMessageId).toBe(first.id);
    expect((await signalsOf(qa.id)).map((s) => s.kind)).toEqual(["wake"]);
    // Its first unrequested run still open: the next one waits for room instead of starting.
    const second = await unattended("a customer disputes the invoice total");
    await runJob("message.posted", { messageId: second.id });
    expect((await runsOf(qa.id)).map((r) => r.triggerMessageId)).not.toContain(second.id);
    expect((await signalsOf(qa.id)).map((s) => s.kind).sort()).toEqual(["later", "wake"]);
    // Room again: the later look starts it through the word path (it names no mention).
    await f.db.update(schema.agentRuns).set({ status: "done" }).where(eq(schema.agentRuns.agentId, qa.id));
    await runJob("autonomy.later", { messageId: second.id, agentId: qa.id, look: 1 });
    expect((await runsOf(qa.id)).map((r) => r.triggerMessageId)).toContain(second.id);
  });

  test("an agent switched off isn't woken by its words", async () => {
    f = await setup();
    const qa = await agentInGeneral("QA", "qa");
    await setBrakes(qa.id, { on: false, wakeWords: ["invoice"] });
    await ask("the invoice is late");
    await drainOutbox(f.db, f.handlers);
    expect(await runsOf(qa.id)).toHaveLength(0);
  });
});

describe("hand-offs between agents", () => {
  /** A run of @dev in #general a person started, and its tool context. */
  async function devRun() {
    const trigger = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "person", userId: f.owner.id },
      body: "@dev pergunta ao QA",
    });
    const [run] = await f.db
      .insert(schema.agentRuns)
      .values({
        orgId: f.org.id,
        agentId: f.agent.id,
        channelId: f.general.id,
        threadRootId: trigger.id,
        triggerMessageId: trigger.id,
        trigger: "mention",
        hop: 1,
      })
      .returning();
    if (!run) throw new Error("no run");
    return {
      db: f.db,
      orgId: f.org.id,
      agentId: f.agent.id,
      runId: run.id,
      channelId: f.general.id,
      threadRootId: trigger.id,
      triggerMessageId: trigger.id,
    };
  }
  const invoke = (ctx: Awaited<ReturnType<typeof devRun>>, name: string, input: Record<string, unknown>) => {
    if (!f.tools) throw new Error("no tools");
    return f.tools.invoke(ctx, { toolUseId: `tu_${crypto.randomUUID()}`, name, input });
  };

  test("ask_agent and tell_agent are refused up front, nothing written, when the agent takes no hand-offs or is off", async () => {
    f = await setup({ askAgent: true, reply: () => ({ chunks: ["Ok."] }) });
    const qa = await agentInGeneral("QA", "qa");
    const ctx = await devRun();
    const log = captureLog();
    try {
      await setBrakes(qa.id, { wakeHandOffs: false });
      expect(await invoke(ctx, "ask_agent", { agent: "@qa", question: "Está pronto?" })).toMatchObject({
        output: { isError: true, content: expect.stringContaining("doesn't take hand-offs") },
      });
      await setBrakes(qa.id, { on: false });
      expect(await invoke(ctx, "tell_agent", { agent: "@qa", message: "Assume daqui." })).toMatchObject({
        output: { isError: true, content: expect.stringContaining("switched off") },
      });
      expect(await f.db.select().from(schema.agentConsultations)).toHaveLength(0);
      expect(await runsOf(qa.id)).toHaveLength(0);
      expect(log.lines).toContain(`[wake] withheld agent=${qa.id} source=hand_off message=- switch=hand_off`);
    } finally {
      log.restore();
    }
    // Back on: the hand-off goes through.
    await setBrakes(qa.id, {});
    expect(await invoke(ctx, "ask_agent", { agent: "@qa", question: "Está pronto?" })).toMatchObject({
      output: { content: expect.stringContaining("Asked @qa") },
    });
  });
});

describe("its own scheduled wakes", () => {
  test("routines: scheduled wakes off skips the slot; a run asked by hand needs only the agent on", async () => {
    f = await setup();
    const routine = await channelRoutine(f);
    await setBrakes(f.agent.id, { wakeScheduled: false });
    expect(await fire(f, routine.id, minutesFromNow(-30), "schedule")).toMatchObject({
      status: "skipped",
      code: "wake_off",
      agentRunId: null,
    });
    const byHand = await fire(f, routine.id, minutesFromNow(-20), "manual");
    expect(byHand.agentRunId).not.toBeNull();
    // Off, not even a run asked by hand starts.
    await f.db.update(schema.routineRuns).set({ status: "done" }).where(eq(schema.routineRuns.id, byHand.id));
    await f.db.update(schema.agentRuns).set({ status: "done" }).where(eq(schema.agentRuns.agentId, f.agent.id));
    await setBrakes(f.agent.id, { on: false });
    expect(await fire(f, routine.id, minutesFromNow(-10), "manual")).toMatchObject({
      status: "skipped",
      code: "wake_off",
    });
  });
});
