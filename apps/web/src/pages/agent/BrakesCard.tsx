import { type AgentBrakes, BRAKES_DEFAULTS, useAgents, useUpdateAgent } from "@agenteschat/client";
import { can } from "@agenteschat/client/lib/permissions";
import {
  Button,
  Card,
  CheckboxPill,
  Input,
  Segmented,
  Select,
  SettingNote,
  SettingRow,
  SettingsSection,
  Switch,
} from "@agenteschat/ui";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/components/org-context";
import { useToast } from "@/lib/toast";
import { CardHead, useAgentEdit } from "./context";

const AT_ONCE = ["1", "2", "3", "5", "10"];
const PRS = ["0", "1", "2", "3", "5", "10"];
const MOVE_MINUTES = ["2", "4", "5", "10", "15", "30", "60", "120"];
const MOVE_CALLS = ["10", "20", "30", "50", "100", "200"];
/** A list of choices that also holds the saved value, so a value set elsewhere still shows. */
const withValue = (list: string[], value: number) =>
  (list.includes(String(value)) ? list : [...list, String(value)].sort((a, b) => Number(a) - Number(b))).map((n) => ({
    value: n,
    label: n,
  }));

/**
 * Configurações → Autonomia sem pedido (ADR 0131): what the agent may start that nobody asked for directly (costly
 * work asks first, how many jobs at once, PRs an hour) and which agents it may call. Saved at once, outside the page's
 * save bar, by who manages agents; everyone else reads it. The defaults keep today's autonomy for normal use. Its last
 * section is when the agent wakes up: on/off and one switch per source of wakes (the server's `wake-controls.ts`); after
 * it, the switches over Agentes' own interventions in its replies (the follow-through judge, the move to background work).
 */
export function BrakesCard() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const { agent } = useAgentEdit();
  const update = useUpdateAgent(org.id, agent.id);
  const agents = useAgents(org.id);
  const toast = useToast();
  const editable = can(org, "manage_agents");
  const saved: AgentBrakes = agent.brakes ?? BRAKES_DEFAULTS;
  const pending = update.isPending ? (update.variables?.brakes ?? {}) : {};
  const b = { ...saved, ...pending };
  const [project, setProject] = useState(b.project);
  useEffect(() => setProject(saved.project), [saved.project]);
  const w = { ...BRAKES_DEFAULTS, ...b } as Required<AgentBrakes>;
  const savedWords = (saved.wakeWords ?? []).join(", ");
  const [words, setWords] = useState(savedWords);
  useEffect(() => setWords(savedWords), [savedWords]);
  const wordList = (text: string) =>
    text
      .split(",")
      .map((v) => v.trim().slice(0, 80))
      .filter(Boolean)
      .slice(0, 50);
  const save = (patch: Partial<AgentBrakes>) => {
    if (!editable) return;
    update.mutate({ brakes: patch }, { onError: () => toast.show(t("brakes.failed"), "error") });
  };
  const others = (agents.data ?? []).filter((a) => !a.former && a.id !== agent.id);
  const remembered = [
    ...b.go.map((k) => t("brakes.rememberedGo", { what: t(`brakes.cost.${k}`) })),
    ...b.never.map((k) => t("brakes.rememberedNever", { what: t(`brakes.cost.${k}`) })),
  ];
  return (
    <Card as="section" className="agp-card" aria-labelledby="agp-brakes">
      <CardHead id="agp-brakes" icon="shield" title={t("brakes.title")} subtitle={t("brakes.subtitle")} />
      <SettingRow
        title={t("brakes.costly")}
        hint={{ name: t("common.about", { label: t("brakes.costly") }), text: t("brakes.costlyHelp") }}
      >
        <Segmented
          size="sm"
          label={t("brakes.costly")}
          value={b.costly}
          disabled={!editable}
          onValueChange={(costly) => save({ costly })}
          options={[
            { value: "ask", label: t("brakes.costlyAsk") },
            { value: "go", label: t("brakes.costlyGo") },
          ]}
        />
      </SettingRow>
      {remembered.length > 0 && (
        <SettingNote icon="check">
          {remembered.join(" · ")}{" "}
          {editable && (
            <Button variant="ghost" size="sm" onClick={() => save({ go: [], never: [] })}>
              {t("brakes.forget")}
            </Button>
          )}
        </SettingNote>
      )}
      <SettingRow
        title={t("brakes.atOnce")}
        hint={{ name: t("common.about", { label: t("brakes.atOnce") }), text: t("brakes.atOnceHelp") }}
        htmlFor="agp-brakes-once"
      >
        <Select
          id="agp-brakes-once"
          size="sm"
          value={String(b.maxUnrequested)}
          disabled={!editable}
          onValueChange={(v) => save({ maxUnrequested: Number(v) })}
          options={AT_ONCE.map((n) => ({ value: n, label: n }))}
        />
      </SettingRow>
      <SettingRow
        title={t("brakes.prs")}
        hint={{ name: t("common.about", { label: t("brakes.prs") }), text: t("brakes.prsHelp") }}
        htmlFor="agp-brakes-prs"
      >
        <Select
          id="agp-brakes-prs"
          size="sm"
          value={String(b.maxPrsPerHour)}
          disabled={!editable}
          onValueChange={(v) => save({ maxPrsPerHour: Number(v) })}
          options={PRS.map((n) => ({ value: n, label: n }))}
        />
      </SettingRow>
      <SettingRow
        title={t("brakes.call")}
        hint={{ name: t("common.about", { label: t("brakes.call") }), text: t("brakes.callHelp") }}
      >
        <Segmented
          size="sm"
          label={t("brakes.call")}
          value={b.callAgents}
          disabled={!editable}
          onValueChange={(callAgents) => save({ callAgents })}
          options={[
            { value: "all", label: t("brakes.callAll") },
            { value: "some", label: t("brakes.callSome") },
            { value: "none", label: t("brakes.callNone") },
          ]}
        />
      </SettingRow>
      {b.callAgents === "some" && (
        <div className="newag__pills">
          {others.map((a) => (
            <CheckboxPill
              key={a.id}
              id={`agp-brakes-call-${a.id}`}
              checked={b.callAgentIds.includes(a.id)}
              disabled={!editable}
              onCheckedChange={(on) =>
                save({
                  callAgentIds: on ? [...b.callAgentIds, a.id] : b.callAgentIds.filter((id) => id !== a.id),
                })
              }
            >
              {`@${a.handle}`}
            </CheckboxPill>
          ))}
        </div>
      )}
      <SettingRow
        title={t("brakes.project")}
        hint={{ name: t("common.about", { label: t("brakes.project") }), text: t("brakes.projectHelp") }}
        htmlFor="agp-brakes-project"
      >
        <Input
          id="agp-brakes-project"
          value={project}
          maxLength={80}
          placeholder={t("brakes.projectPlaceholder")}
          disabled={!editable}
          onChange={(e) => setProject(e.target.value)}
          onBlur={() => project.trim() !== saved.project && save({ project: project.trim() })}
        />
      </SettingRow>
      {b.project && (
        <SettingRow title={t("brakes.otherProjects")} htmlFor="agp-brakes-other">
          <Switch
            id="agp-brakes-other"
            checked={b.otherProjects}
            disabled={!editable}
            onCheckedChange={(otherProjects) => save({ otherProjects })}
          />
        </SettingRow>
      )}
      <SettingNote icon="info" quiet>
        {t("brakes.peopleNote")}
      </SettingNote>
      <SettingsSection title={t("brakes.wake.title")}>
        <SettingRow
          title={t("brakes.wake.on")}
          hint={{ name: t("common.about", { label: t("brakes.wake.on") }), text: t("brakes.wake.onHelp") }}
          htmlFor="agp-wake-on"
        >
          <Switch id="agp-wake-on" checked={w.on} disabled={!editable} onCheckedChange={(on) => save({ on })} />
        </SettingRow>
        {!w.on && <SettingNote icon="info">{t("brakes.wake.offNote")}</SettingNote>}
        <SettingRow title={t("brakes.wake.people")} htmlFor="agp-wake-people">
          <Switch
            id="agp-wake-people"
            checked={w.wakePeople}
            disabled={!editable || !w.on}
            onCheckedChange={(wakePeople) => save({ wakePeople })}
          />
        </SettingRow>
        <SettingRow
          title={t("brakes.wake.agents")}
          hint={{ name: t("common.about", { label: t("brakes.wake.agents") }), text: t("brakes.wake.agentsHelp") }}
        >
          <Segmented
            size="sm"
            label={t("brakes.wake.agents")}
            value={w.wakeAgents}
            disabled={!editable || !w.on}
            onValueChange={(wakeAgents) => save({ wakeAgents })}
            options={[
              { value: "judge", label: t("brakes.wake.judge") },
              { value: "always", label: t("brakes.wake.always") },
              { value: "off", label: t("brakes.wake.off") },
            ]}
          />
        </SettingRow>
        <SettingRow
          title={t("brakes.wake.router")}
          hint={{ name: t("common.about", { label: t("brakes.wake.router") }), text: t("brakes.wake.routerHelp") }}
          htmlFor="agp-wake-router"
        >
          <Switch
            id="agp-wake-router"
            checked={w.wakeRouter}
            disabled={!editable || !w.on}
            onCheckedChange={(wakeRouter) => save({ wakeRouter })}
          />
        </SettingRow>
        <SettingRow title={t("brakes.wake.handOffs")} htmlFor="agp-wake-handoffs">
          <Switch
            id="agp-wake-handoffs"
            checked={w.wakeHandOffs}
            disabled={!editable || !w.on}
            onCheckedChange={(wakeHandOffs) => save({ wakeHandOffs })}
          />
        </SettingRow>
        <SettingRow title={t("brakes.wake.scheduled")} htmlFor="agp-wake-scheduled">
          <Switch
            id="agp-wake-scheduled"
            checked={w.wakeScheduled}
            disabled={!editable || !w.on}
            onCheckedChange={(wakeScheduled) => save({ wakeScheduled })}
          />
        </SettingRow>
        <SettingRow
          title={t("brakes.wake.words")}
          hint={{ name: t("common.about", { label: t("brakes.wake.words") }), text: t("brakes.wake.wordsHelp") }}
          htmlFor="agp-wake-words"
        >
          <Input
            id="agp-wake-words"
            value={words}
            maxLength={2000}
            placeholder={t("brakes.wake.wordsPlaceholder")}
            disabled={!editable || !w.on}
            onChange={(e) => setWords(e.target.value)}
            onBlur={() => {
              const list = wordList(words);
              if (list.join(", ") !== savedWords) save({ wakeWords: list });
            }}
          />
        </SettingRow>
        {w.wakeWords.length > 0 && (
          <SettingRow title={t("brakes.wake.wordsFrom")}>
            <Segmented
              size="sm"
              label={t("brakes.wake.wordsFrom")}
              value={w.wakeWordsFrom}
              disabled={!editable || !w.on}
              onValueChange={(wakeWordsFrom) => save({ wakeWordsFrom })}
              options={[
                { value: "people", label: t("brakes.wake.fromPeople") },
                { value: "agents", label: t("brakes.wake.fromAgents") },
                { value: "both", label: t("brakes.wake.fromBoth") },
              ]}
            />
          </SettingRow>
        )}
      </SettingsSection>
      <SettingsSection title={t("brakes.replies.title")}>
        <SettingRow
          title={t("brakes.replies.followThrough")}
          hint={{
            name: t("common.about", { label: t("brakes.replies.followThrough") }),
            text: t("brakes.replies.followThroughHelp"),
          }}
          htmlFor="agp-replies-follow"
        >
          <Switch
            id="agp-replies-follow"
            checked={w.followThrough}
            disabled={!editable}
            onCheckedChange={(followThrough) => save({ followThrough })}
          />
        </SettingRow>
        <SettingRow
          title={t("brakes.replies.workMove")}
          hint={{
            name: t("common.about", { label: t("brakes.replies.workMove") }),
            text: t("brakes.replies.workMoveHelp"),
          }}
          htmlFor="agp-replies-move"
        >
          <Switch
            id="agp-replies-move"
            checked={w.workMove}
            disabled={!editable}
            onCheckedChange={(workMove) => save({ workMove })}
          />
        </SettingRow>
        {w.workMove && (
          <>
            <SettingRow title={t("brakes.replies.workMoveAfterMin")} htmlFor="agp-replies-move-min">
              <Select
                id="agp-replies-move-min"
                size="sm"
                value={String(w.workMoveAfterMin)}
                disabled={!editable}
                onValueChange={(v) => save({ workMoveAfterMin: Number(v) })}
                options={withValue(MOVE_MINUTES, w.workMoveAfterMin)}
              />
            </SettingRow>
            <SettingRow
              title={t("brakes.replies.workMoveAfterCalls")}
              hint={{
                name: t("common.about", { label: t("brakes.replies.workMoveAfterCalls") }),
                text: t("brakes.replies.workMoveAfterCallsHelp"),
              }}
              htmlFor="agp-replies-move-calls"
            >
              <Select
                id="agp-replies-move-calls"
                size="sm"
                value={String(w.workMoveAfterCalls)}
                disabled={!editable}
                onValueChange={(v) => save({ workMoveAfterCalls: Number(v) })}
                options={withValue(MOVE_CALLS, w.workMoveAfterCalls)}
              />
            </SettingRow>
          </>
        )}
        <SettingRow
          title={t("brakes.replies.workCheckIns")}
          hint={{
            name: t("common.about", { label: t("brakes.replies.workCheckIns") }),
            text: t("brakes.replies.workCheckInsHelp"),
          }}
          htmlFor="agp-replies-checkins"
        >
          <Switch
            id="agp-replies-checkins"
            checked={w.workCheckIns}
            disabled={!editable}
            onCheckedChange={(workCheckIns) => save({ workCheckIns })}
          />
        </SettingRow>
      </SettingsSection>
    </Card>
  );
}
