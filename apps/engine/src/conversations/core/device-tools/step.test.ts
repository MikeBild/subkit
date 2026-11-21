import { describe, expect, test } from "bun:test";
import { decideDeviceTool } from "../../instruction-cover/device-decision.ts";
import { chatJob, chatRequest, type JobState } from "../../instruction-cover/job.ts";
import { deviceToolSpec } from "./catalog.ts";
import { personalBoundary } from "./palette.ts";
import {
  assembleDeviceStep,
  chordKey,
  chordName,
  type FilledValue,
  recipientsOf,
  type StepFacts,
} from "./step.ts";

const NOW = new Date("2026-11-21T10:00:00Z");

function facts(name: string, input: Record<string, unknown>, extra: Partial<StepFacts> = {}) {
  const tool = deviceToolSpec(name);
  if (!tool) throw new Error(name);
  return assembleDeviceStep({
    tool,
    input,
    job_id: "job",
    element: null,
    page_origin: null,
    app: null,
    filled: [],
    ...extra,
  });
}

function chat(message: string, shown: string[] = []) {
  const request = chatRequest([{ id: "m1", kind: "message", text: message }], shown, "UTC");
  const job: JobState = {
    ...chatJob({ anchor_id: "job", anchor_at: NOW }),
    device: personalBoundary([
      {
        kind: "keep_out",
        display: "/Users/anna/Private",
        entered_by: "person",
        keep_out_target: "folder",
      },
    ]),
  };
  return { request, job };
}

function decide(message: string, assembled: ReturnType<typeof facts>, askBeforeWriting = false) {
  return decideDeviceTool({
    ...chat(message),
    assembled,
    ask_before_writing: askBeforeWriting,
    now: NOW,
  });
}

describe("recipients come from the values the job filled in", () => {
  test.each<[FilledValue[], string[]]>([
    [
      [{ field: "An", value: "anna@example.com, ben@example.com" }],
      ["anna@example.com", "ben@example.com"],
    ],
    [[{ field: "Betreff", value: "Hallo" }], []],
    [[{ field: null, value: "x@y.de; ;" }], ["x@y.de"]],
    [[{ field: "Recipients", value: "Team Nord" }], ["Team Nord"]],
    [[{ field: "Empfänger", value: "Anna" }], ["Anna"]],
    [[{ field: "Toast", value: "Anna" }], []],
    [[{ field: "cc", value: "a@b.c" }], ["a@b.c"]],
    [[{ field: "Body", value: "write to x@y" }], []],
    [[{ field: "Body", value: "a@b.c d" }], []],
    [[{ field: "Feld An", value: "Anna" }], ["Anna"]],
    [[{ field: "Recipient", value: "Anna" }], ["Anna"]],
    [[{ field: "Email", value: "Anna" }], ["Anna"]],
    [[{ field: "Body", value: "x a@b.c" }], []],
    [[{ field: "Body", value: "ab@c.de" }], ["ab@c.de"]],
    [[{ field: "Body", value: "a@bc.de" }], ["a@bc.de"]],
    [[{ field: "An", value: "a,, b" }], ["a", "b"]],
  ])("%j", (filled, expected) => {
    expect(recipientsOf(filled)).toEqual(expected);
  });
});

describe("chords", () => {
  test("well-known chords get the name of what they do", () => {
    expect(chordKey(" Command + S ")).toBe("cmd+s");
    expect(chordKey("⌘+Enter")).toBe("cmd+enter");
    expect(chordKey("Control+S")).toBe("ctrl+s");
    expect(chordName("cmd+s")).toBe("Save");
    expect(chordName("ctrl+s")).toBe("Save");
    expect(chordName("cmd+return")).toBe("Send");
    expect(chordName("cmd+shift+d")).toBe("Send");
    expect(chordName("cmd+enter")).toBe("Send");
    expect(chordName("cmd+backspace")).toBe("Delete");
    expect(chordName("cmd+delete")).toBe("Delete");
    expect(chordName("tab")).toBe("tab");
  });
});

describe("browser steps are classified from the fresh snapshot, not from the model", () => {
  test("opening a page reads and names its origin", () => {
    const { step } = facts("browser_open", { url: "https://shop.example.com/a?b=1" });
    expect(step).toMatchObject({
      kind: "device",
      job_id: "job",
      capability: "browser",
      phase: "read",
      always_ask: null,
      target: "https://shop.example.com",
      url: "https://shop.example.com/a?b=1",
      quote: null,
    });
    expect(facts("browser_open", { url: "not a url" }).step.target).toBe("not a url");
    expect(facts("browser_open", { url: "data:text/plain,hi" }).step.target).toBe(
      "data:text/plain,hi",
    );
  });

  test("a pay button is a payment whatever the model calls it", () => {
    const { step } = facts(
      "browser_press",
      { action: "click", ref: "e3", because: "search for shoes" },
      {
        element: { role: "button", name: "Jetzt kaufen" },
        page_origin: "https://shop.example.com",
      },
    );
    expect(step).toMatchObject({
      phase: "commit",
      always_ask: "payment",
      name: "Jetzt kaufen",
      target: "https://shop.example.com",
      url: "https://shop.example.com",
      quote: "search for shoes",
    });
  });

  test("cookie banners prepare, scrolling reads, keys classify", () => {
    expect(
      facts(
        "browser_press",
        { action: "click" },
        { element: { role: "button", name: "Accept all cookies" } },
      ).step.phase,
    ).toBe("prepare");
    expect(facts("browser_press", { action: "scroll", direction: "down" }).step.phase).toBe("read");
    expect(facts("browser_press", { action: "key", key: "Tab" }).step.phase).toBe("prepare");
    expect(facts("browser_press", { action: "key", key: "Enter" }).step.phase).toBe("commit");
    expect(facts("browser_press", { action: "click" }).step.target).toBeNull();
  });

  test("filling prepares, a password field always asks", () => {
    expect(
      facts(
        "browser_fill",
        { ref: "e2", mode: "fill", text: "Anna" },
        { element: { role: "textbox", name: "Name" } },
      ).step,
    ).toMatchObject({ phase: "prepare", always_ask: null, values: ["Anna"], name: "Name" });
    expect(
      facts(
        "browser_fill",
        { ref: "e2", mode: "fill", text: "x" },
        { element: { role: "textbox", name: "Passwort" } },
      ).step.always_ask,
    ).toBe("credential");
    expect(
      facts(
        "browser_fill",
        { ref: "e2", mode: "select", values: ["2", 3] },
        { element: { role: "combobox", name: "Personen" } },
      ).step,
    ).toMatchObject({ phase: "prepare", values: ["2", "3"] });
    expect(facts("browser_fill", { ref: "e2", mode: "fill", text: "" }).step.values).toEqual([]);
    expect(facts("browser_fill", { ref: "e2", mode: "fill" }).step.values).toEqual([]);
  });

  test("the snapshot's role decides, a search field prepares", () => {
    const search = {
      element: { role: "searchbox", name: "" },
      page_origin: "https://a.example.com",
    };
    expect(facts("browser_press", { action: "click" }, search).step.phase).toBe("prepare");
    expect(
      facts("browser_press", { action: "click" }, { ...search, element: { role: null, name: "" } })
        .step.phase,
    ).toBe("commit");
    const link = { role: "link", name: "Coffee", href: "/products/coffee" };
    expect(facts("browser_press", { action: "click" }, { element: link }).step.phase).toBe("read");
    expect(facts("browser_open", { url: "https://a.example.com" }).other_paths).toEqual([]);
  });

  test("reading tools read", () => {
    for (const name of [
      "browser_snapshot",
      "browser_wait",
      "browser_extract",
      "browser_screenshot",
    ]) {
      expect(facts(name, {}).step).toMatchObject({
        phase: "read",
        always_ask: null,
        name: null,
        values: [],
      });
    }
  });

  test("sending asks unless the job filled in recipients, which then must be the person's", () => {
    const send = {
      element: { role: "button", name: "Senden" },
      page_origin: "https://mail.example.com",
    };
    expect(facts("browser_press", { action: "click" }, send).step.always_ask).toBe("sending");
    const filled = facts(
      "browser_press",
      { action: "click" },
      {
        ...send,
        filled: [{ field: "An", value: "anna@example.com" }],
      },
    ).step;
    expect(filled).toMatchObject({
      always_ask: null,
      values: ["anna@example.com"],
      phase: "commit",
    });
    expect(
      facts(
        "browser_press",
        { action: "click" },
        {
          ...send,
          element: { role: "button", name: "Kaufen" },
          filled: [{ field: "An", value: "a@b.c" }],
        },
      ).step.always_ask,
    ).toBe("payment");
  });
});

describe("computer steps", () => {
  const element = { role: "button", name: "Sichern" };

  test("press classifies the control of the snapshot", () => {
    expect(
      facts("computer_press", { ref: "@s1:e1" }, { element, app: "Numbers" }).step,
    ).toMatchObject({
      capability: "computer",
      phase: "commit",
      always_ask: null,
      name: "Sichern",
      target: "Numbers",
    });
    expect(
      facts(
        "computer_press",
        { ref: "@s1:e1" },
        { element: { role: "button", name: "Delete event" }, app: "Kalender" },
      ).step.always_ask,
    ).toBe("deletion");
    expect(facts("computer_press", { ref: "@s1:e1" }).step.target).toBeNull();
  });

  test("a menu item in an app prepares", () => {
    const menu = facts(
      "computer_press",
      { ref: "@s1:e1" },
      { element: { role: "menuitem", name: "" } },
    );
    expect(menu.step.phase).toBe("prepare");
    expect(menu.other_paths).toEqual([]);
    expect(
      facts("computer_press", { ref: "@s1:e1" }, { element: { role: null, name: "" } }).step.phase,
    ).toBe("commit");
  });

  test("typing prepares with its values", () => {
    expect(facts("computer_type", { ref: "@s1:e2", text: "42" }, { element }).step).toMatchObject({
      phase: "prepare",
      values: ["42"],
    });
    expect(facts("computer_set_value", { ref: "@s1:e2", value: "7" }).step.values).toEqual(["7"]);
    expect(facts("computer_select", { ref: "@s1:e2", option: "B" }).step.values).toEqual(["B"]);
    expect(
      facts(
        "computer_select",
        { ref: "@s1:e2", option: "B" },
        { element: { role: "popupbutton", name: "Kategorie" } },
      ).step,
    ).toMatchObject({ phase: "prepare", always_ask: null, name: "Kategorie" });
    expect(
      facts(
        "computer_set_value",
        { ref: "@s1:e2", value: "7" },
        { element: { role: "textfield", name: "Betrag" } },
      ).step,
    ).toMatchObject({ phase: "prepare", name: "Betrag" });
  });

  test("focus and scroll prepare; apps, snapshots and screenshots read", () => {
    expect(facts("computer_focus", { ref: "@s1:e2" }, { element }).step).toMatchObject({
      phase: "prepare",
      always_ask: null,
      name: "Sichern",
      values: [],
    });
    expect(facts("computer_scroll", { ref: "@s1:e2" }).step).toMatchObject({
      phase: "prepare",
      name: null,
    });
    for (const name of ["computer_apps", "computer_snapshot", "computer_screenshot"]) {
      expect(facts(name, {}).step.phase).toBe("read");
    }
  });

  test("keys are named by what they do and blocked chords are refused before sending", () => {
    const save = facts("computer_key", { window_id: "w", keys: "cmd+s" }, { app: "Numbers" });
    expect(save.step).toMatchObject({ phase: "commit", name: "Save" });
    expect(save.blocked).toBeNull();
    expect(facts("computer_key", { window_id: "w", keys: "tab" }).step.phase).toBe("prepare");
    expect(facts("computer_key", { window_id: "w", keys: "cmd+q" }).blocked).toBe(
      "blocked_shortcut",
    );
    expect(facts("computer_key", { window_id: "w" }).step.name).toBe("undefined");
    expect(facts("computer_press", { ref: "@s1:e2", keys: "cmd+q" }).blocked).toBeNull();
    expect(facts("computer_press", { ref: "@s1:e2" }).blocked).toBeNull();
  });

  test("a send button in an app follows the same recipient rule", () => {
    const send = { element: { role: "button", name: "Send" }, app: "Mail" };
    expect(facts("computer_press", { ref: "@s1:e3" }, send).step.always_ask).toBe("sending");
    expect(
      facts(
        "computer_press",
        { ref: "@s1:e3" },
        { ...send, filled: [{ field: "To", value: "ben@example.com" }] },
      ).step,
    ).toMatchObject({ always_ask: null, values: ["ben@example.com"] });
  });
});

describe("file steps", () => {
  test.each([
    ["files_list", { path: "/Users/a/Docs" }, "read", null, null],
    ["files_read", { path: "/Users/a/x.txt" }, "read", null, null],
    ["files_write", { path: "/Users/a/report.txt", text: "" }, "commit", null, "save report.txt"],
    ["files_mkdir", { path: "/Users/a/Rechnungen/" }, "commit", null, "create folder Rechnungen"],
    ["files_trash", { path: "/Users/a/setup.dmg" }, "commit", "deletion", "trash setup.dmg"],
  ] as const)("%s", (name, input, phase, always_ask, label) => {
    const { step, other_paths, blocked } = facts(name, input);
    expect(step).toMatchObject({ phase, always_ask, name: label, values: [], capability: "files" });
    expect(step.path).toEqual({ lexical: input.path, real: input.path });
    expect(step.target).toBe(input.path);
    expect(other_paths).toEqual([]);
    expect(blocked).toBeNull();
  });

  test("a move checks the source and writes the destination", () => {
    const moved = facts("files_move", { from: "/Users/a/x.pdf", to: "/Users/a/Rechnungen/x.pdf" });
    expect(moved.step).toMatchObject({
      phase: "commit",
      name: "move x.pdf to x.pdf",
      target: "/Users/a/Rechnungen/x.pdf",
    });
    expect(moved.other_paths).toEqual(["/Users/a/x.pdf"]);
    expect(facts("files_move", {}).other_paths).toEqual([""]);
    expect(facts("files_move", {}).step).toMatchObject({
      name: "move  to ",
      path: null,
      target: null,
    });
  });
});

describe("the device decision uses the one trust check", () => {
  const open = () => facts("browser_open", { url: "https://shop.example.com" });

  test("reading runs inside the person's job", () => {
    expect(decide("Öffne shop.example.com", open())).toMatchObject({
      decision: "covered",
      by: "routine",
    });
  });

  test("a commit the person asked for runs, one they did not asks", () => {
    const save = facts("files_write", {
      path: "/Users/anna/report.txt",
      text: "x",
      because: "speicher den Bericht",
    });
    expect(decide("Bitte speicher den Bericht unter report.txt", save)).toMatchObject({
      decision: "covered",
      by: "request",
    });
    const unasked = facts("files_write", { path: "/Users/anna/report.txt", text: "x" });
    expect(decide("Bitte speicher den Bericht", unasked)).toMatchObject({
      decision: "ask",
      reason: "no_quote",
    });
  });

  test("a recipient the person named sends; one copied from a page asks", () => {
    const send = (to: string) =>
      facts(
        "browser_press",
        { action: "click", because: "schick die Mail an anna@example.com" },
        {
          element: { role: "button", name: "Senden" },
          page_origin: "https://mail.example.com",
          filled: [{ field: "An", value: to }],
        },
      );
    const message =
      "Schreib auf mail.example.com eine Mail und schick die Mail an anna@example.com";
    expect(decide(message, send("anna@example.com"))).toMatchObject({ decision: "covered" });
    expect(decide(message, send("x@evil.example"))).toMatchObject({
      decision: "ask",
      reason: "value_not_given",
    });
  });

  test("keep-out folders and blocked chords refuse", () => {
    const keep = facts("files_read", { path: "/Users/anna/Private/a.txt" });
    expect(decide("Lies a.txt", keep)).toMatchObject({
      decision: "refuse",
      reason: "outside_device_boundary",
    });
    const move = facts("files_move", {
      from: "/Users/anna/Private/a.txt",
      to: "/Users/anna/a.txt",
      because: "verschieb a.txt",
    });
    expect(decide("verschieb a.txt", move)).toEqual({
      decision: "refuse",
      reason: "outside_device_boundary",
      detail: "outside_allowance",
    });
    const fine = facts("files_move", {
      from: "/Users/anna/b.txt",
      to: "/Users/anna/c.txt",
      because: "verschieb b.txt",
    });
    expect(decide("verschieb b.txt nach c.txt", fine).decision).toBe("covered");
    expect(decide("drück cmd+q", facts("computer_key", { window_id: "w", keys: "cmd+q" }))).toEqual(
      {
        decision: "refuse",
        reason: "outside_device_boundary",
        detail: "blocked_shortcut",
      },
    );
  });

  test("asking before writing still reads, everything else asks, refusals stay refusals", () => {
    expect(decide("Öffne shop.example.com", open(), true)).toMatchObject({ decision: "covered" });
    expect(decide("Öffne shop.example.com", open())).toMatchObject({ decision: "covered" });
    const save = facts("files_write", {
      path: "/Users/anna/report.txt",
      text: "x",
      because: "speicher den Bericht",
    });
    expect(decide("speicher den Bericht", save, true)).toEqual({
      decision: "ask",
      reason: "ask_before_writing",
    });
    expect(decide("speicher den Bericht", save)).toMatchObject({ decision: "covered" });
    const keep = facts("files_read", { path: "/Users/anna/Private/a.txt" });
    expect(decide("Lies a.txt", keep, true)).toMatchObject({ decision: "refuse" });
    const kept = facts("files_write", {
      path: "/Users/anna/Private/a.txt",
      text: "x",
      because: "speicher a.txt",
    });
    expect(decide("speicher a.txt", kept, true)).toMatchObject({
      decision: "refuse",
      reason: "outside_device_boundary",
    });
    const cookies = facts(
      "browser_press",
      { action: "click" },
      {
        element: { role: "button", name: "Accept all cookies" },
        page_origin: "https://shop.example.com",
      },
    );
    expect(decide("Öffne shop.example.com", cookies, true)).toEqual({
      decision: "ask",
      reason: "ask_before_writing",
    });
  });
});
