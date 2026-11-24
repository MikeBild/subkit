import { describe, expect, test } from "bun:test";
import type { Setup } from "@/api/setup";
import { pairVisibility } from "@/features/operations";
import { type TranslationKey, translate } from "@/lib/i18n";
import {
  answersFromSetup,
  daysLabel,
  firstJobPrompt,
  firstJobStarter,
  JOB_SERVICES,
  OTHER,
  pairLine,
  personalStartSteps,
  postponeSetup,
  questionError,
  questionUpdate,
  recommendedUpdate,
  SETUP_JOBS,
  SETUP_QUESTIONS,
  scheduleNote,
  scheduleSentence,
  setupApprovers,
  setupGateView,
  setupKeys,
  setupPending,
  setupPostponed,
  setupUpdate,
  setupValue,
  toggleDay,
  workingDays,
} from "./setup-model";

const t = (key: TranslationKey, values?: Record<string, string | number>) =>
  translate("de", key, values);

const untouched: Setup = {
  ask_before_writing: false,
  default_environment: "dev",
  approver: { kind: "self" },
  notifications: { mode: "immediately" },
  timezone: null,
  critical_breakthrough: false,
  save_new_notes: true,
  first_job: null,
  services: [],
  unset: ["default_environment", "approver", "notifications"],
  recommended: {
    ask_before_writing: false,
    default_environment: "dev",
    approver: { kind: "self" },
    notifications: { mode: "immediately" },
    critical_breakthrough: false,
  },
  spend: { limit_usd: 50, can_change: false },
  updated_at: null,
};

describe("the AI budget question", () => {
  const admin: Setup = { ...untouched, spend: { limit_usd: 50, can_change: true } };

  test("only a workspace admin is asked, and only then is the limit sent", () => {
    expect(setupKeys(untouched)).not.toContain("budget");
    expect(setupKeys(admin)).toContain("budget");
    expect(setupUpdate(answersFromSetup(admin), setupKeys(admin)).monthly_spend_usd).toBe(50);
    expect(setupUpdate(answersFromSetup(untouched), setupKeys(untouched))).not.toHaveProperty(
      "monthly_spend_usd",
    );
  });

  test("no limit is 0 and reads as such, and the answer sets exactly that one setting", () => {
    const none = answersFromSetup({ ...admin, spend: { limit_usd: null, can_change: true } });
    expect(none.budget).toBe(0);
    expect(setupValue("budget", none, t)).toBe("Ohne Grenze");
    expect(questionUpdate("budget", { ...none, budget: 200 })).toEqual({ monthly_spend_usd: 200 });
    expect(setupValue("budget", { ...none, budget: 200 }, (k, v) => translate("en", k, v))).toBe(
      "$200",
    );
  });
});

describe("setup answers", () => {
  test("the step shows while a choice is unset and goes once all are made", () => {
    expect(setupPending(untouched)).toBe(true);
    expect(setupPending({ unset: ["notifications"] })).toBe(true);
    expect(setupPending({ unset: [] })).toBe(false);
    expect(setupPending(undefined)).toBe(false);
  });

  test("the step is offered once to people who may change settings and never to end users", () => {
    const builder = ["workflow:read", "settings:write"];
    const endUser = ["workflow:read", "workflow:run", "conversation:write"];
    const open = { permissions: builder, postponed: false, failed: false };
    expect(setupGateView({ ...open, setup: undefined })).toBe("checking");
    expect(setupGateView({ ...open, setup: untouched })).toBe("open");
    expect(setupGateView({ ...open, setup: { unset: [] } })).toBe("passed");
    expect(setupGateView({ ...open, setup: untouched, postponed: true })).toBe("passed");
    expect(setupGateView({ ...open, setup: undefined, failed: true })).toBe("passed");
    expect(setupGateView({ ...open, permissions: endUser, setup: untouched })).toBe("passed");
    expect(setupGateView({ ...open, permissions: endUser, setup: undefined })).toBe("passed");
  });

  test("not now is remembered per person and workspace, also without storage", () => {
    const kept = new Map<string, string>();
    const store = {
      getItem: (key: string) => kept.get(key) ?? null,
      setItem: (key: string, value: string) => void kept.set(key, value),
    };
    const lena = { tenantId: "t1", userId: "u1" };
    expect(setupPostponed(lena, store)).toBe(false);
    postponeSetup(lena, store);
    expect(setupPostponed(lena, store)).toBe(true);
    expect(setupPostponed({ tenantId: "t1", userId: "u2" }, store)).toBe(false);
    expect(setupPostponed({ tenantId: "t2", userId: "u1" }, store)).toBe(false);
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(() => postponeSetup(lena, broken)).not.toThrow();
    expect(setupPostponed(lena, broken)).toBe(false);
    expect(setupPostponed(lena, null)).toBe(false);
  });

  test("an untouched setup starts with the recommended answers and no job", () => {
    const answers = answersFromSetup(untouched);
    expect(answers).toMatchObject({
      job: null,
      services: [],
      approver: "self",
      env: "dev",
      notify: "immediately",
    });
    expect(setupValue("job", answers, t)).toBe("Noch nicht gewählt");
  });

  test("not now stores exactly the recommended choices", () => {
    expect(recommendedUpdate(untouched)).toEqual({
      default_environment: "dev",
      approver: { kind: "self" },
      notifications: { mode: "immediately" },
      critical_breakthrough: false,
    });
  });

  test("five answers become one request that names every choice", () => {
    const body = setupUpdate(
      {
        ...answersFromSetup(untouched),
        job: "invoices",
        services: ["gmail", "google-drive"],
        approver: "teammate",
        approverEmail: " anna@example.com ",
        env: "prod",
        notify: "working_hours",
        from: "09:00",
        to: "17:30",
        timezone: "Europe/Berlin",
        critical: true,
      },
      setupKeys(untouched),
    );
    expect(body).toEqual({
      first_job: "invoices",
      services: ["gmail", "google-drive"],
      approver: { kind: "teammate", email: "anna@example.com" },
      default_environment: "prod",
      notifications: { mode: "working_hours", from: "09:00", to: "17:30", days: [1, 2, 3, 4, 5] },
      timezone: "Europe/Berlin",
      critical_breakthrough: true,
    });
  });

  test("a change in settings touches only the setting it names", () => {
    const answers = {
      ...answersFromSetup(untouched),
      notify: "daily_digest" as const,
      at: "07:15",
    };
    expect(questionUpdate("notify", answers)).toEqual({
      notifications: { mode: "daily_digest", at: "07:15" },
      timezone: null,
      critical_breakthrough: false,
    });
    expect(Object.keys(questionUpdate("env", answers))).toEqual(["default_environment"]);
    expect(Object.keys(questionUpdate("approver", answers))).toEqual(["approver"]);
    expect(Object.keys(questionUpdate("services", answers))).toEqual(["services"]);
  });

  test("a job in the person's own words is stored as they wrote it and read back as other", () => {
    const own = {
      ...answersFromSetup(untouched),
      job: OTHER,
      jobOther: "  Belege sortieren ",
    } as const;
    expect(questionUpdate("job", own)).toEqual({ first_job: "Belege sortieren", services: [] });
    const back = answersFromSetup({ ...untouched, first_job: "Belege sortieren" });
    expect(back.job).toBe(OTHER);
    expect(setupValue("job", back, t)).toBe("Belege sortieren");
  });

  test("an answer that cannot be stored names what is missing", () => {
    const base = answersFromSetup(untouched);
    expect(questionError("job", { ...base, job: OTHER, jobOther: " " })).toBe("setup.otherError");
    expect(questionError("services", base)).toBe("setup.servicesError");
    expect(
      questionError("approver", { ...base, approver: "teammate", approverEmail: "anna" }),
    ).toBe("setup.emailError");
    expect(
      questionError("notify", { ...base, notify: "working_hours", from: "", to: "18:00" }),
    ).toBe("setup.timeError");
    expect(questionError("notify", { ...base, notify: "daily_digest", at: "25:00" })).toBe(
      "setup.timeError",
    );
    for (const id of ["approver", "env", "notify"] as const)
      expect(questionError(id, base)).toBeNull();
  });

  test("every answer reads in plain words", () => {
    const answers = answersFromSetup({
      ...untouched,
      first_job: "tickets",
      services: ["jira", "github", "other"],
      approver: {
        kind: "teammate",
        email: "anna@example.com",
        user_id: null,
        invite_id: null,
        invitation: "pending",
        can_approve: true,
        missing_permissions: [],
      },
      default_environment: "prod",
      notifications: { mode: "working_hours", from: "08:00", to: "18:00" },
    });
    expect(SETUP_QUESTIONS.map((id) => setupValue(id, answers, t))).toEqual([
      "Offene Tickets auflisten",
      "Jira · GitHub · Anderer Dienst",
      "Jemand anderes im Team · anna@example.com",
      "Direkt im Echtbetrieb",
      "Arbeitszeiten Mo–Fr 08:00–18:00 · Zeitzone des Arbeitsbereichs · Kritisches wartet mit",
      "50 $",
    ]);
    expect(
      setupValue("notify", { ...answers, timezone: "America/New_York", critical: true }, t),
    ).toBe("Arbeitszeiten Mo–Fr 08:00–18:00 · Zeitzone America/New York · Kritisches sofort");
    expect(setupValue("notify", { ...answers, notify: "immediately", critical: true }, t)).toBe(
      "Sofort",
    );
    expect(scheduleSentence({ mode: "daily_digest", at: "08:00" }, t)).toBe(
      "Zusammenfassung um 08:00",
    );
  });

  test("the notification note says which channel follows the schedule and nothing about the others", () => {
    const scheduled = scheduleNote(
      {
        notifications: { mode: "working_hours", from: "08:00", to: "18:00" },
        timezone: "Europe/Berlin",
        critical_breakthrough: true,
      },
      t,
    );
    expect(scheduled.line).toBe("Push aus deiner Einrichtung: Mo–Fr 08:00–18:00");
    expect(scheduled.chips).toEqual(["Zeitzone Europe/Berlin", "Kritisches sofort"]);
    expect(scheduled.detail).toBe(
      `${translate("de", "setup.schedule.scope")} ${translate("de", "setup.schedule.expiry")}`,
    );
    for (const locale of ["de", "en"] as const) {
      const expiry = translate(locale, "setup.schedule.expiry");
      expect(expiry).toContain("7");
      expect(expiry).toContain("3");
      expect(
        scheduleNote(untouched, (key, values) => translate(locale, key, values)).detail,
      ).toContain(expiry);
    }
    const immediate = scheduleNote(untouched, t);
    expect(immediate.chips).toEqual([]);
    expect(immediate.detail).toContain("Push-Benachrichtigungen");
    for (const locale of ["de", "en"] as const)
      expect(translate(locale, "setup.schedule.scope")).not.toMatch(/mail/i);
  });

  test("every job preselects services the setup can name", () => {
    for (const job of SETUP_JOBS) {
      expect(translate("de", `setup.job.${job}`)).not.toBe(`setup.job.${job}`);
      expect(JOB_SERVICES[job].length).toBeGreaterThan(0);
    }
  });
});

describe("what the answers change on the overview and in chat", () => {
  const steps = [
    {
      id: "connector",
      title: "Dienst verbinden",
      line: "Verbinde einen Dienst.",
      href: "/connectors",
      done: false,
    },
    { id: "workflow", title: "Workflow", line: "Beschreib ihn.", href: "/chat/new", done: true },
  ];
  const chosen = { first_job: "invoices", services: ["gmail", "google-drive", "other"] };

  test("the chosen job is the first step and the chosen services lead the connector step", () => {
    const personal = personalStartSteps(
      steps,
      chosen,
      t,
      (prompt) => `/chat/new?prompt=${prompt.length}`,
    );
    expect(personal.map((step) => step.id)).toEqual(["first-job", "connector", "workflow"]);
    expect(personal[0]).toMatchObject({
      title: "„Rechnungen ablegen“ einrichten",
      line: "Dein erster Auftrag. Der Chat ist schon vorbereitet.",
      done: true,
    });
    expect(personal[1]?.line).toBe("Zuerst: Gmail · Google Drive. Verbinde einen Dienst.");
  });

  test("without a job, without the right to chat or before setup loads the steps stay as they are", () => {
    expect(personalStartSteps(steps, { first_job: null, services: [] }, t, () => "/x")).toEqual(
      steps,
    );
    expect(personalStartSteps(steps, undefined, t, () => "/x")).toEqual(steps);
    expect(personalStartSteps(steps, { ...chosen, services: [] }, t, () => null)).toEqual(steps);
  });

  test("the chat offers the chosen job first, with the services in the prepared message", () => {
    expect(firstJobPrompt(chosen, t)).toBe(
      "Ich möchte das als meinen ersten Auftrag einrichten: Rechnungen ablegen. Dafür nutze ich Gmail, Google Drive.",
    );
    expect(firstJobStarter(chosen, t)).toMatchObject({
      id: "first-job",
      title: "Rechnungen ablegen",
    });
    expect(firstJobStarter({ first_job: null, services: [] }, t)).toBeNull();
    expect(firstJobStarter(undefined, t)).toBeNull();
  });
});

describe("working days of the notification schedule", () => {
  test("Monday to Friday is the default and is sent with the working hours", () => {
    expect(workingDays(undefined)).toEqual([1, 2, 3, 4, 5]);
    const answers = answersFromSetup({
      ...untouched,
      notifications: { mode: "working_hours", from: "08:00", to: "18:00", days: [6, 2] },
    });
    expect(answers.days).toEqual([2, 6]);
    expect(questionUpdate("notify", answers).notifications).toEqual({
      mode: "working_hours",
      from: "08:00",
      to: "18:00",
      days: [2, 6],
    });
  });

  test("a day toggles in weekday order and at least one must stay", () => {
    expect(toggleDay([1, 2, 3, 4, 5], 6)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(toggleDay([1, 2, 3, 4, 5], 3)).toEqual([1, 2, 4, 5]);
    const none = { ...answersFromSetup(untouched), notify: "working_hours" as const, days: [] };
    expect(questionError("notify", none)).toBe("setup.daysError");
  });

  test("days read as a range, a list or every day, in both languages", () => {
    const en = (key: TranslationKey, values?: Record<string, string | number>) =>
      translate("en", key, values);
    expect(daysLabel([1, 2, 3, 4, 5], t)).toBe("Mo–Fr");
    expect(daysLabel([1, 3, 5], t)).toBe("Mo, Mi, Fr");
    expect(daysLabel([6, 7], t)).toBe("Sa, So");
    expect(daysLabel([1, 2, 3, 4, 5, 6, 7], t)).toBe("täglich");
    expect(daysLabel([1, 2, 3, 4, 5], en)).toBe("Mon–Fri");
    expect(
      scheduleSentence({ mode: "working_hours", from: "09:00", to: "17:00", days: [2, 3, 4] }, en),
    ).toBe("Tue–Thu 09:00–17:00");
  });
});

describe("approving together", () => {
  const pairApprover = (
    pair: "active" | "needs_second_approver" | "needs_admin",
  ): Setup["approver"] => ({
    kind: "pair",
    email: "anna@example.com",
    user_id: null,
    invite_id: null,
    invitation: "pending",
    can_approve: null,
    missing_permissions: [],
    pair,
  });

  test("the pair answer round-trips with the partner address", () => {
    const answers = answersFromSetup({ ...untouched, approver: pairApprover("active") });
    expect(answers.approver).toBe("pair");
    expect(answers.approverEmail).toBe("anna@example.com");
    expect(questionUpdate("approver", { ...answers, approverEmail: " anna@example.com " })).toEqual(
      { approver: { kind: "pair", email: "anna@example.com" } },
    );
    expect(setupValue("approver", answers, t)).toBe("Gemeinsam freigeben · anna@example.com");
  });

  test("the setup question offers approving together only when the workspace can use it", () => {
    expect(setupApprovers(false)).toEqual(["self", "teammate"]);
    expect(setupApprovers(true)).toEqual(["self", "teammate", "pair"]);
  });

  test("a lone administrator can pick approving together to invite the second (#552)", () => {
    const lone = pairVisibility({ workflow_approvals: "single", eligible_approvers: 1 });
    expect(setupApprovers(lone.option)).toEqual(["self", "teammate", "pair"]);
  });

  test("approving together needs a partner address", () => {
    const base = answersFromSetup(untouched);
    expect(questionError("approver", { ...base, approver: "pair", approverEmail: "" })).toBe(
      "setup.emailError",
    );
    expect(
      questionError("approver", { ...base, approver: "pair", approverEmail: "anna@example.com" }),
    ).toBeNull();
  });

  test("the pair state reads as one line", () => {
    expect(pairLine({ kind: "self" }, t)).toBeNull();
    expect(pairLine(pairApprover("active"), t)).toEqual({
      tone: "success",
      state: "active",
      text: "Gemeinsam freigeben ist aktiv: du und anna@example.com gebt jeden Workflow frei",
    });
    expect(pairLine(pairApprover("needs_second_approver"), t)).toEqual({
      tone: "info",
      state: "needs_second_approver",
      text: "Gemeinsam freigeben startet, sobald anna@example.com dabei ist",
    });
    expect(pairLine(pairApprover("needs_admin"), t)?.tone).toBe("warning");
  });
});
