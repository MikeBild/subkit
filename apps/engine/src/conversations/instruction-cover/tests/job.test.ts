import { describe, expect, test } from "bun:test";
import { FROZEN_NOW } from "../../../test-helpers/determinism/index.ts";
import {
  boundaryRefusal,
  CHAT_JOB_LIFETIME_MS,
  chatJob,
  chatRequest,
  coversResult,
  type DeviceStep,
  decideJobStep,
  deviceSignature,
  extraAlwaysAsk,
  type JobRequest,
  namedHosts,
  paysOnSubmit,
  siteNamed,
  taskJob,
  taskRequest,
} from "../job.ts";
import { asksForWork, holdsBack } from "../request.ts";

const NOW = new Date(FROZEN_NOW);
const TZ = "Europe/Berlin";

function said(...messages: string[]): JobRequest {
  return chatRequest(
    messages.map((text, index) => ({ id: `m${index}`, kind: "message", text })),
    [],
    TZ,
  );
}

const JOB = chatJob({ anchor_id: "m0", anchor_at: NOW });

function device(extra: Partial<DeviceStep>): DeviceStep {
  return {
    kind: "device",
    job_id: "m0",
    capability: "browser",
    phase: "prepare",
    always_ask: null,
    name: null,
    target: "https://tisch.example",
    values: [],
    quote: null,
    ...extra,
  };
}

const BOOK = "Book a table for 2 at tisch.example on Friday";

describe("a job binds one request to the steps that reach its result", () => {
  test("a chat job lives for its lifetime from the person's message", () => {
    expect(JOB.expires_at.getTime() - JOB.started_at.getTime()).toBe(CHAT_JOB_LIFETIME_MS);
    const late = new Date(NOW.getTime() + CHAT_JOB_LIFETIME_MS);
    expect(decideJobStep(said(BOOK), JOB, device({ phase: "read" }), late)).toEqual({
      decision: "refuse",
      reason: "job_expired",
    });
  });

  test("a step of another job is refused", () => {
    expect(decideJobStep(said(BOOK), JOB, device({ job_id: "m9" }), NOW)).toMatchObject({
      decision: "refuse",
      reason: "other_job",
    });
  });

  test("reads and routine preparation run without a quote", () => {
    for (const phase of ["read", "prepare"] as const) {
      expect(decideJobStep(said(BOOK), JOB, device({ phase }), NOW)).toMatchObject({
        decision: "covered",
        by: "routine",
        signature: null,
      });
    }
  });

  test("the always-ask classes ask inside a covered job", () => {
    for (const always_ask of ["payment", "deletion", "sending", "credential"] as const) {
      expect(
        decideJobStep(said(BOOK), JOB, device({ phase: "commit", always_ask, quote: BOOK }), NOW),
      ).toMatchObject({ decision: "ask", reason: "always_ask", detail: always_ask });
    }
    expect(
      decideJobStep(
        said(BOOK),
        JOB,
        device({ phase: "commit", name: "Sign up", quote: BOOK }),
        NOW,
      ),
    ).toMatchObject({ decision: "ask", reason: "always_ask", detail: "account_creation" });
  });

  test("a value the person did not give asks before it is typed", () => {
    const typed = (value: string) =>
      decideJobStep(said(BOOK), JOB, device({ values: [value] }), NOW).decision;
    expect(typed("2")).toBe("covered");
    expect(typed("mallory@evil.example")).toBe("ask");
  });

  test("a commit runs once when the person's words ask for that result on the named site", () => {
    const step = device({
      phase: "commit",
      name: "Confirm booking",
      quote: "Book a table for 2 at tisch.example",
    });
    const first = decideJobStep(said(BOOK), JOB, step, NOW);
    expect(first).toMatchObject({
      decision: "covered",
      by: "request",
      because: { quote: "Book a table for 2 at tisch.example", message_id: "m0" },
      signature: deviceSignature(step),
    });
    const used = { ...JOB, used_signatures: new Set([deviceSignature(step)]) };
    expect(decideJobStep(said(BOOK), used, step, NOW)).toMatchObject({ reason: "already_used" });
    expect(
      decideJobStep(said(BOOK), JOB, { ...step, target: "https://partner.example" }, NOW),
    ).toMatchObject({ reason: "target_not_named" });
    expect(decideJobStep(said(BOOK), JOB, { ...step, name: "Write a review" }, NOW)).toMatchObject({
      reason: "commit_not_requested",
    });
    expect(decideJobStep(said(BOOK), JOB, { ...step, quote: null }, NOW)).toMatchObject({
      reason: "no_quote",
    });
  });

  test("an earlier message no longer covers after a new one, and holding back stops preparation", () => {
    const step = device({ phase: "commit", name: "Confirm booking", quote: BOOK });
    expect(decideJobStep(said(BOOK, "What is the weather?"), JOB, step, NOW)).toMatchObject({
      reason: "quote_not_in_user_words",
    });
    expect(decideJobStep(said(BOOK, "Stop, wait."), JOB, device({}), NOW)).toMatchObject({
      reason: "conditional_or_negated",
    });
  });

  test("a task run is the job and only its owner's start covers", () => {
    const facts = {
      task_id: "t",
      task_run_id: "run-1",
      owner_id: "owner",
      goal: "Book the meeting room at tisch.example every Monday",
      done_when: "",
      goal_edited_by: "owner",
      started_by: null,
      created_at: NOW,
      deadline_at: new Date(NOW.getTime() + 60_000),
    };
    const job = taskJob(facts);
    const step = device({
      job_id: "run-1",
      phase: "commit",
      name: "Book room",
      quote: "Book the meeting room at tisch.example",
    });
    expect(job).toMatchObject({ id: "run-1", origin: "task", expires_at: facts.deadline_at });
    expect(taskRequest(facts, TZ).by_person).toBe(true);
    expect(taskRequest({ ...facts, started_by: "owner" }, TZ).by_person).toBe(true);
    expect(decideJobStep(taskRequest(facts, TZ), job, step, NOW).decision).toBe("covered");
    const other = taskRequest({ ...facts, started_by: "someone" }, TZ);
    expect(decideJobStep(other, job, step, NOW)).toMatchObject({
      decision: "refuse",
      reason: "not_started_by_person",
    });
    expect(
      decideJobStep(
        other,
        job,
        { kind: "tool", job_id: "run-1", tool: "call_connector", args: {}, quote: null },
        NOW,
      ),
    ).toMatchObject({ decision: "ask", reason: "not_started_by_person" });
  });

  test("a goal someone else edited last gives no cover until the owner edits it again", () => {
    const facts = {
      task_id: "t",
      task_run_id: "run-1",
      owner_id: "owner",
      goal: "Book the meeting room at tisch.example every Monday",
      done_when: "Room is booked",
      goal_edited_by: "admin",
      started_by: null,
      created_at: NOW,
      deadline_at: new Date(NOW.getTime() + 60_000),
    };
    const job = taskJob(facts);
    const commit = device({
      job_id: "run-1",
      phase: "commit",
      name: "Book room",
      quote: "Book the meeting room at tisch.example",
    });
    const write = {
      kind: "tool" as const,
      job_id: "run-1",
      tool: "call_connector",
      args: {},
      quote: "Book the meeting room at tisch.example",
    };
    const edited = taskRequest(facts, TZ);
    expect(edited.segments).toEqual([]);
    expect(edited.by_person).toBe(true);
    expect(decideJobStep(edited, job, commit, NOW).decision).toBe("ask");
    expect(decideJobStep(edited, job, write, NOW).decision).toBe("ask");
    expect(taskRequest({ ...facts, goal_edited_by: null }, TZ).segments).toEqual([]);
    const reedited = taskRequest({ ...facts, goal_edited_by: "owner" }, TZ);
    expect(reedited.segments).toEqual([
      {
        id: null,
        kind: "message",
        text: "Book the meeting room at tisch.example every Monday\nRoom is booked",
      },
    ]);
    expect(decideJobStep(reedited, job, commit, NOW).decision).toBe("covered");
  });
});

describe("result words and sites", () => {
  test.each([
    ["Order the coffee beans", "Proceed to checkout", true],
    ["Bestell den Kaffee", "Zur Kasse", true],
    ["Reservier einen Tisch", "Tisch reservieren", true],
    ["Fill the Budget sheet", "Save", true],
    ["Find a free table", "Confirm booking", false],
    ["Book a table", "Submit review", false],
    ["Schick die Mail an Anna", "Senden", true],
    ["Antworte Ben", "Antwort senden", true],
    ["Forward it to Ben", "Send", true],
    ["Read my mail", "Send", false],
  ])("%s covers %s: %p", (quote, name, expected) => {
    expect(coversResult(quote, name)).toBe(expected);
  });

  test("named sites bind commits, unnamed requests leave the site open", () => {
    expect(namedHosts("Book at tisch.example, mail anna@firma.de")).toEqual(["tisch.example"]);
    expect(siteNamed("https://www.tisch.example", ["tisch.example"])).toBe(true);
    expect(siteNamed("https://evil-tisch.example", ["tisch.example"])).toBe(false);
    expect(siteNamed("https://any.example", [])).toBe(true);
  });

  test("settings and accounts are always-ask commits", () => {
    expect(extraAlwaysAsk("Konto erstellen")).toBe("account_creation");
    expect(extraAlwaysAsk("Save settings")).toBe("permission_or_settings");
    expect(extraAlwaysAsk("Add to cart")).toBeNull();
  });

  test("questions and held-back messages are not requests for work", () => {
    expect(asksForWork("was kostet der kaffee?")).toBe(false);
    expect(asksForWork("kannst du den tisch buchen?")).toBe(true);
    expect(holdsBack("nein, doch nicht bestellen")).toBe(true);
    expect(holdsBack("bestell den kaffee, keine milch")).toBe(false);
  });
  test("a submit that pays asks even when its button only says checkout", () => {
    expect(paysOnSubmit("/checkout/pay")).toBe(true);
    expect(paysOnSubmit("/kasse/zahlung")).toBe(true);
    expect(paysOnSubmit("/cart/update")).toBe(false);
    expect(paysOnSubmit(null)).toBe(false);
    const step = device({
      phase: "commit",
      name: "Checkout",
      quote: "Order the coffee at tisch.example",
      submits_to: "/checkout/pay",
    });
    expect(decideJobStep(said("Order the coffee at tisch.example"), JOB, step, NOW)).toMatchObject({
      decision: "ask",
      reason: "always_ask",
      detail: "payment",
    });
  });

  test("the device's personal boundary refuses private, odd-port, kept-out and system places", () => {
    const boundary = {
      sites: { entered_by_person: [] },
      paths: { os: "darwin" as const, data_dir: null, keep_out: ["/Users/mike/Privat"] },
    };
    const site = (url: string) => boundaryRefusal(boundary, device({ url }));
    expect(site("https://shop-demo.de/p/1")).toBeNull();
    expect(site("http://192.168.1.1/")).toBe("private_address");
    expect(site("https://shop-demo.de:8443/")).toBe("origin_not_allowed");
    const file = (path: string) =>
      boundaryRefusal(
        boundary,
        device({ capability: "files", path: { lexical: path, real: path } }),
      );
    expect(file("/Users/mike/Downloads/a.pdf")).toBeNull();
    expect(file("/Users/mike/Privat/tagebuch.txt")).not.toBeNull();
    expect(file("/etc/passwd")).not.toBeNull();
    expect(boundaryRefusal(undefined, device({ url: "http://10.0.0.1/" }))).toBeNull();
    const job = { ...JOB, device: boundary };
    expect(
      decideJobStep(said(BOOK), job, device({ phase: "read", url: "http://10.0.0.1/" }), NOW),
    ).toEqual({
      decision: "refuse",
      reason: "outside_device_boundary",
      detail: "private_address",
    });
  });
});
