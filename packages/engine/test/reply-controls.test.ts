import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { type ModelRequest, systemText, textOf } from "@agenteschat/providers";
import {
  type AgentRun,
  AUTONOMY_DEFAULTS,
  autonomySettings,
  checkInWork,
  drainOutbox,
  getAgent,
  moveToBackground,
  postPersonMessage,
  type ToolSource,
  updateAgent,
  WORK_AUTO_AFTER_CALLS,
  WORK_AUTO_AFTER_MS,
  WORK_IN_BACKGROUND_TOOL,
  WORK_LIMITS,
  workEligible,
} from "../src";
import {
  CONTINUE_THE_CONVERSATION,
  finishWhatYouStart,
  PLAIN_WORDS_LINE,
  WORK_IN_BACKGROUND_LINE,
} from "../src/context";
import { decideTurnEnd, FOLLOW_THROUGH_OFF, type TurnEnd } from "../src/continuation";
import { type Fixture, setup } from "./fixtures";

/**
 * Per-agent switches over Agentes' own interventions in an agent's replies, stored with its autonomy brakes: the
 * follow-through judge, the move to background work and the built-in lines in its instructions. Untouched, every one is today's behaviour.
 */

setDefaultTimeout(30_000);

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const lastUserText = (request: ModelRequest) => {
  const last = request.messages.at(-1);
  return last ? textOf(last.content) : "";
};

const judgeCalls = (fx: Fixture, kind: string) =>
  (fx.context.judge as unknown as { calls: { kind: string }[] }).calls.filter((c) => c.kind === kind);

const agentMessages = async (fx: Fixture) =>
  (await fx.db.select().from(schema.messages).orderBy(schema.messages.createdAt)).filter(
    (m) => m.authorType === "agent" && !m.meta.notice,
  );

const ask = (fx: Fixture, body: string) =>
  postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, fx.general.id, { body });

const setBrakes = (fx: Fixture, brakes: Record<string, unknown>) =>
  updateAgent(fx.db, fx.owner.id, fx.org.id, fx.agent.id, { autonomyBrakes: brakes });

describe("the settings", () => {
  test("untouched, the follow-through judge is on; only a stored false turns it off", () => {
    expect(autonomySettings({}).followThrough).toBe(true);
    expect(AUTONOMY_DEFAULTS.followThrough).toBe(true);
    expect(autonomySettings({ followThrough: "no" }).followThrough).toBe(true);
    expect(autonomySettings({ followThrough: false }).followThrough).toBe(false);
  });

  test("saved through updateAgent next to the wake controls, only the fields given", async () => {
    f = await setup();
    await setBrakes(f, { wakeRouter: false });
    await setBrakes(f, { followThrough: false });
    expect((await getAgent(f.db, f.org.id, f.agent.id))?.autonomyBrakes).toEqual({
      wakeRouter: false,
      followThrough: false,
    });
  });
});

describe("the follow-through judge", () => {
  const turn = (over: Partial<TurnEnd> = {}): TurnEnd => ({
    state: { count: 0 },
    kind: "conversation",
    executed: 0,
    bound: null,
    quiet: false,
    decided: null,
    unanswered: false,
    unreached: "",
    judged: "I'll check again later and send the numbers.",
    mission: false,
    wakesLater: async () => false,
    verdict: async () => "continue",
    ...over,
  });

  test("off: no judgment, no nudge of any kind, the turn ends with its reply", async () => {
    let asked = 0;
    const verdict = async () => {
      asked++;
      return "continue" as const;
    };
    const off = { followThrough: false, verdict };
    expect(await decideTurnEnd(turn(off))).toEqual({ outcome: "done", rule: FOLLOW_THROUGH_OFF });
    // The controller's other extra turns stay off too: a decision's result, an empty answer, a request still open,
    // a widget's data, a reply naming its tools or citing files on its computer.
    for (const over of [
      { decided: "approved: merged" },
      { unanswered: true },
      { openRequest: "say whether you still need it" },
      { widgetOwed: true },
      { namedTools: ["post_message"] },
      { localPaths: ["/home/agent/report.md"] },
    ])
      expect((await decideTurnEnd(turn({ ...off, ...over }))).outcome).toBe("done");
    expect(asked).toBe(0);
    // A quiet turn stays quiet (nothing posted), and a bound still says why it ended.
    expect((await decideTurnEnd(turn({ ...off, quiet: true }))).rule).toBe("quiet");
    expect((await decideTurnEnd(turn({ ...off, bound: "stuck" }))).rule).toBe("stuck");
  });

  test("untouched: today's controller (the judge reads the reply and a promise gets its nudge)", async () => {
    let asked = 0;
    const d = await decideTurnEnd(
      turn({
        verdict: async () => {
          asked++;
          return "continue";
        },
      }),
    );
    expect(asked).toBe(1);
    expect(d).toMatchObject({ outcome: "continue", rule: "promise" });
    expect((await decideTurnEnd(turn({ followThrough: true }))).rule).toBe("promise");
  });

  test("off in a run: the promise is posted as written, once, with no judge call and no extra turn", async () => {
    const promised = "O job de testes ainda está rodando. Vou checar de novo daqui a pouco e te passo os números.";
    f = await setup({
      judge: (kind) => (kind === "follow_through" ? "continue" : undefined),
      reply: () => ({ chunks: [promised] }),
    });
    await setBrakes(f, { followThrough: false });
    await ask(f, "@dev o ci demora tanto assim?");
    await drainOutbox(f.db, f.handlers);
    expect(f.provider.calls.length).toBe(1);
    expect(judgeCalls(f, "follow_through")).toEqual([]);
    expect((await agentMessages(f)).map((m) => m.body)).toEqual([promised]);
    const [run] = await f.db.select().from(schema.agentRuns);
    expect(run?.status).toBe("done");
    expect(run?.threadRootId).toBe(run?.triggerMessageId);
    const steps = await f.db.select().from(schema.agentRunSteps);
    expect(steps.some((s) => (s.data.continuation as { rule?: string } | undefined)?.rule === FOLLOW_THROUGH_OFF)).toBe(
      true,
    );
    expect(steps.some((s) => s.data.nudged)).toBe(false);
  });

  test("on (untouched) in the same run: the judge is asked and the promise gets one more turn", async () => {
    f = await setup({
      judge: (kind) => (kind === "follow_through" ? "continue" : undefined),
      reply: (_request, call) => ({
        chunks: [call === 1 ? "Vou checar de novo e te passo os números." : "Pronto: 12 min."],
      }),
    });
    await ask(f, "@dev o ci demora tanto assim?");
    await drainOutbox(f.db, f.handlers);
    expect(judgeCalls(f, "follow_through").length).toBeGreaterThan(0);
    expect(f.provider.calls.length).toBeGreaterThan(1);
    expect(lastUserText(f.provider.calls[1]?.request as ModelRequest)).toContain("You ended saying you would do more");
  });
});

describe("the move to background work", () => {
  const works = (fx: Fixture) => fx.db.select().from(schema.agentWorks);
  /** A tool that takes a while, or no time at all: the run's work. */
  const toolOf = (ms: number): ToolSource => ({
    name: "build",
    tools: async () => [
      {
        name: "build",
        description: "Build",
        scope: "context:read",
        inputSchema: { type: "object", properties: {} },
        execute: async () => {
          await Bun.sleep(ms);
          return { content: "built" };
        },
      },
    ],
  });

  test("untouched: the move is on at today's limits (4 minutes, 20 calls), check-ins on; limits are clamped", () => {
    const s = autonomySettings({});
    expect(s).toMatchObject({ workMove: true, workMoveAfterMin: 4, workMoveAfterCalls: 20, workCheckIns: true });
    expect(s.workMoveAfterMin * 60_000).toBe(WORK_AUTO_AFTER_MS);
    expect(s.workMoveAfterCalls).toBe(WORK_AUTO_AFTER_CALLS);
    expect(autonomySettings({ workMoveAfterMin: 0, workMoveAfterCalls: 9999 })).toMatchObject({
      workMoveAfterMin: 2,
      workMoveAfterCalls: 500,
    });
    expect(autonomySettings({ workMoveAfterMin: "ten" }).workMoveAfterMin).toBe(4);
  });

  test("off: a long run stays in the conversation, the tool isn't offered and the prompt doesn't ask for it", async () => {
    f = await setup({
      workTools: true,
      toolSources: [toolOf(400)],
      workAuto: { afterMs: 100, tickMs: 20 },
      reply: (_req, call) =>
        call === 1 ? { chunks: [], toolUses: [{ name: "build", input: {} }] } : { chunks: ["Build pronto."] },
    });
    await setBrakes(f, { workMove: false });
    await ask(f, "@dev builda o app");
    await drainOutbox(f.db, f.handlers);
    expect(await works(f)).toHaveLength(0);
    expect((await agentMessages(f)).map((m) => [m.body, m.threadId])).toEqual([["Build pronto.", null]]);
    const first = f.provider.calls[0]?.request as ModelRequest;
    expect((first.tools ?? []).some((t) => t.name === WORK_IN_BACKGROUND_TOOL)).toBe(false);
    expect(systemText(first.system ?? [])).not.toContain("call work_in_background first");
    const [run] = await f.db.select().from(schema.agentRuns);
    expect(await workEligible(f.db, { ...(run as AgentRun), status: "running" })).toBe(false);
  });

  test("on (untouched), the same run moves after the limit", async () => {
    f = await setup({
      workTools: true,
      toolSources: [toolOf(400)],
      workAuto: { afterMs: 100, tickMs: 20 },
      reply: (_req, call) =>
        call === 1 ? { chunks: [], toolUses: [{ name: "build", input: {} }] } : { chunks: ["Build pronto."] },
    });
    await ask(f, "@dev builda o app");
    await drainOutbox(f.db, f.handlers);
    expect((await works(f))[0]?.how).toBe("auto");
  });

  test("the agent's own call limit replaces the server's", async () => {
    const reply = (_req: ModelRequest, call: number) =>
      call <= 4 ? { chunks: [], toolUses: [{ name: "build", input: {} }] } : { chunks: ["Feito."] };
    // The server's limit is far away here: untouched, nothing moves.
    f = await setup({ workTools: true, toolSources: [toolOf(40)], workAuto: { minMs: 50, tickMs: 10 }, reply });
    await ask(f, "@dev confere tudo");
    await drainOutbox(f.db, f.handlers);
    expect(await works(f)).toHaveLength(0);
    await f.close();

    f = await setup({ workTools: true, toolSources: [toolOf(40)], workAuto: { minMs: 50, tickMs: 10 }, reply });
    await setBrakes(f, { workMoveAfterCalls: 2 });
    await ask(f, "@dev confere tudo");
    await drainOutbox(f.db, f.handlers);
    expect((await works(f))[0]?.how).toBe("auto");
  });

  test("check-ins off: no reminder of a promised update and no note of Agentes' own; on, both", async () => {
    for (const checkIns of [false, true]) {
      f = await setup();
      if (!checkIns) await setBrakes(f, { workCheckIns: false });
      await ask(f, "@dev roda a migração");
      const [queued] = await f.db.select().from(schema.agentRuns);
      const [run] = await f.db
        .update(schema.agentRuns)
        .set({ status: "running", startedAt: new Date(), heartbeatAt: new Date() })
        .where(eq(schema.agentRuns.id, queued?.id as string))
        .returning();
      const out = await moveToBackground({ db: f.db, pubsub: f.pubsub }, run?.id as string, {
        how: "agent",
        title: "Migrar a cobrança",
        say: "Vou cuidar disso.",
      });
      const work = out?.work;
      if (!work?.nextUpdateAt) throw new Error("not moved");
      const deps = { db: f.db, pubsub: f.pubsub };
      const due = new Date(work.nextUpdateAt.getTime() + 1000);
      const later = new Date(due.getTime() + WORK_LIMITS.graceMs);
      const nudge = await checkInWork(deps, f.org.id, { workId: work.id, seq: 0, phase: "nudge" }, due);
      const fallback = await checkInWork(deps, f.org.id, { workId: work.id, seq: 0, phase: "fallback" }, later);
      const all = await f.db.select().from(schema.messages);
      const reminders = all.filter((m) => (m.meta.notice as { kind?: string } | undefined)?.kind === "work_check_in");
      const notes = all.filter((m) => (m.meta.workUpdate as { auto?: boolean } | undefined)?.auto);
      if (checkIns) {
        expect([nudge, fallback]).toEqual(["nudged", "posted"]);
        expect([reminders.length, notes.length]).toEqual([1, 1]);
      } else {
        expect([nudge, fallback]).toEqual(["none", "none"]);
        expect([reminders.length, notes.length]).toEqual([0, 0]);
      }
      await f.close();
      f = undefined as unknown as Fixture;
    }
  });
});

describe("the built-in lines in its instructions", () => {
  const KEEP_POSTED = "In long work, keep them posted with a short line now and then.";
  const NO_PROMISE = "Never end your turn on a promise you don't keep in it";

  test("untouched, finishWhatYouStart is word for word today's line", () => {
    expect(finishWhatYouStart(true)).toBe(
      "- Finish what you start. Never end your turn on a promise you don't keep in it ('I'll send the numbers', 'vou checar de novo', 'te aviso quando terminar'): do it now. If it has to wait (a build, a deploy, a job still running), set a follow_up to come back to it and say when. After a person approves or answers what you waited on, go on with the task at once and tell them what came of it. When the person already asked for the outcome, do the work instead of asking whether to. In long work, keep them posted with a short line now and then.",
    );
    expect(finishWhatYouStart(false, { noPromise: true, keepPosted: true })).toBe(finishWhatYouStart(false));
    expect(finishWhatYouStart(false, { keepPosted: false })).toBe(
      "- Finish what you start. Never end your turn on a promise you don't keep in it ('I'll send the numbers', 'vou checar de novo', 'te aviso quando terminar'): do it now. If it has to wait, say what is left and what it waits on. After a person approves or answers what you waited on, go on with the task at once and tell them what came of it. When the person already asked for the outcome, do the work instead of asking whether to.",
    );
    expect(finishWhatYouStart(true, { noPromise: false })).toBe(
      "- Finish what you start. After a person approves or answers what you waited on, go on with the task at once and tell them what came of it. When the person already asked for the outcome, do the work instead of asking whether to. In long work, keep them posted with a short line now and then.",
    );
  });

  const promptWith = async (brakes: Record<string, unknown>) => {
    f = await setup({ workTools: true, followUps: true, reply: () => ({ chunks: ["ok"] }) });
    if (Object.keys(brakes).length > 0) await setBrakes(f, brakes);
    await ask(f, "@dev oi");
    await drainOutbox(f.db, f.handlers);
    const text = systemText(f.provider.calls[0]?.request.system ?? []);
    await f.close();
    f = undefined as unknown as Fixture;
    return text;
  };
  const LINES = {
    ruleBackground: WORK_IN_BACKGROUND_LINE,
    ruleKeepPosted: KEEP_POSTED,
    ruleNoPromise: NO_PROMISE,
    rulePlainWords: PLAIN_WORDS_LINE,
    ruleContinue: CONTINUE_THE_CONVERSATION,
  } as const;

  test("untouched: every line is in the instructions", async () => {
    const text = await promptWith({});
    for (const line of Object.values(LINES)) expect(text).toContain(line);
    expect(text).toContain("Finish what you start.");
  });

  test("each switched off leaves out that line alone", async () => {
    for (const [key, line] of Object.entries(LINES)) {
      const text = await promptWith({ [key]: false });
      expect(text).not.toContain(line);
      for (const [other, kept] of Object.entries(LINES)) if (other !== key) expect(text).toContain(kept);
      expect(text).toContain("Finish what you start.");
      expect(text).toContain("After a person approves or answers what you waited on");
    }
  });
});
