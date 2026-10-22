import { describe, expect, test } from "bun:test";
import {
  formatDuration,
  formFromStep,
  isFormStep,
  parseDuration,
  parseHeaders,
  STEP_FORM_ERROR_FIELDS,
  stepFromForm,
  stepKeyFromName,
} from "./step-form";

const CONNECTOR = "7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f";

describe("step form", () => {
  test("durations read as the dialog writes them", () => {
    expect(parseDuration("5 min")).toBe(300_000);
    expect(parseDuration("30 s")).toBe(30_000);
    expect(parseDuration("2 h")).toBe(7_200_000);
    expect(parseDuration("10")).toBe(600_000);
    expect(parseDuration("25 h")).toBeNull();
    expect(parseDuration("bald")).toBeNull();
    expect(formatDuration(300_000)).toBe("5 min");
    expect(formatDuration(7_200_000)).toBe("2 h");
    expect(formatDuration(45_000)).toBe("45 s");
  });

  test("a stored call opens with its values and keeps what the form does not show", () => {
    const stored = {
      id: "send-mail",
      kind: "request",
      connector_id: CONNECTOR,
      method: "POST",
      path: "/messages/send",
      body: { to: "input.to" },
    };
    const form = formFromStep(stored, "");
    expect(form).toMatchObject({ name: "send-mail", kind: "request", method: "POST" });
    const result = stepFromForm({ ...form, path: "/messages/draft" }, stored, []);
    expect(result).toEqual({
      step: { ...stored, path: "/messages/draft" },
    });
  });

  test("changing the kind starts the step afresh", () => {
    const stored = { id: "pause", kind: "request", connector_id: CONNECTOR, path: "/x", body: {} };
    const result = stepFromForm(
      { ...formFromStep(stored, ""), kind: "wait", wait: "5 min" },
      stored,
      [],
    );
    expect(result).toEqual({ step: { id: "pause", kind: "wait", duration_ms: 300_000 } });
  });

  test("what is wrong is named", () => {
    const form = formFromStep(null, CONNECTOR);
    expect(stepFromForm({ ...form, name: "" }, null, [])).toEqual({ error: "nameMissing" });
    expect(stepFromForm({ ...form, name: "Send!" }, null, [])).toEqual({ error: "nameInvalid" });
    expect(stepFromForm({ ...form, name: "a" }, null, ["a"])).toEqual({ error: "nameTaken" });
    expect(stepFromForm({ ...form, name: "a", path: "messages" }, null, [])).toEqual({
      error: "pathInvalid",
    });
    expect(stepFromForm({ ...form, name: "a", connectorId: "" }, null, [])).toEqual({
      error: "connectorMissing",
    });
    expect(stepFromForm({ ...form, name: "a", kind: "wait", wait: "x" }, null, [])).toEqual({
      error: "waitInvalid",
    });
  });

  test("query, headers and body round-trip through the form", () => {
    const stored = {
      id: "search",
      kind: "request",
      connector_id: CONNECTOR,
      method: "POST",
      path: "/search",
      query: { limit: 10, archived: false, q: "open" },
      headers: { Accept: "application/json", "X-Trace": "on" },
      body: { filter: ["a", "b"], nested: { deep: 1 } },
      max_retries: 2,
    };
    const form = formFromStep(stored, "");
    expect(form.headers).toBe("Accept: application/json\nX-Trace: on");
    expect(JSON.parse(form.query)).toEqual(stored.query);
    expect(JSON.parse(form.body)).toEqual(stored.body);
    expect(stepFromForm(form, stored, [])).toEqual({ step: stored });
  });

  test("emptied query, headers and body leave the step", () => {
    const stored = {
      id: "search",
      kind: "request",
      connector_id: CONNECTOR,
      method: "GET",
      path: "/search",
      query: { q: "x" },
      headers: { Accept: "text/plain" },
      body: { a: 1 },
    };
    const form = { ...formFromStep(stored, ""), query: " ", headers: "", body: "" };
    expect(stepFromForm(form, stored, [])).toEqual({
      step: {
        id: "search",
        kind: "request",
        connector_id: CONNECTOR,
        method: "GET",
        path: "/search",
      },
    });
  });

  test("a call without a stored method keeps the engine default GET", () => {
    const stored = { id: "list", kind: "request", connector_id: CONNECTOR, path: "/items" };
    expect(formFromStep(stored, "").method).toBe("GET");
  });

  test("broken query, headers or body are named at their field", () => {
    const form = { ...formFromStep(null, CONNECTOR), name: "a", path: "/x" };
    expect(stepFromForm({ ...form, body: "{ to: " }, null, [])).toEqual({ error: "bodyInvalid" });
    expect(stepFromForm({ ...form, query: "[1]" }, null, [])).toEqual({ error: "queryInvalid" });
    expect(stepFromForm({ ...form, query: '{"a":{"b":1}}' }, null, [])).toEqual({
      error: "queryInvalid",
    });
    expect(stepFromForm({ ...form, headers: "Accept application/json" }, null, [])).toEqual({
      error: "headersInvalid",
    });
    expect(STEP_FORM_ERROR_FIELDS.bodyInvalid).toBe("body");
    expect(STEP_FORM_ERROR_FIELDS.headersInvalid).toBe("headers");
  });

  test("a literal secret header is masked in the form and kept on save", () => {
    const stored = {
      id: "fetch",
      kind: "request",
      connector_id: CONNECTOR,
      method: "GET",
      path: "/users",
      headers: { Authorization: "Bearer plain-secret-token", "X-Api-Key": "{{credentials.key}}" },
    };
    const form = formFromStep(stored, "");
    expect(form.headers).toBe("Authorization: •••\nX-Api-Key: {{credentials.key}}");
    expect(form.headers).not.toContain("plain-secret-token");
    expect(stepFromForm(form, stored, [])).toEqual({ step: stored });
    expect(
      stepFromForm({ ...form, headers: "Authorization: Bearer new" }, stored, []),
    ).toMatchObject({ step: { headers: { Authorization: "Bearer new" } } });
    expect(stepFromForm({ ...form, headers: "Cookie: •••" }, stored, [])).toEqual({
      error: "headersInvalid",
    });
  });

  test("headers parse as Name: Value lines and keep colons in the value", () => {
    expect(parseHeaders("Authorization: Bearer a:b\n\nAccept: */*")).toEqual({
      Authorization: "Bearer a:b",
      Accept: "*/*",
    });
    expect(parseHeaders(": nameless")).toBeNull();
  });

  test("a branch keeps its condition and the steps of both arms", () => {
    const stored = {
      id: "has-items",
      kind: "branch",
      when: "fetch.data.count > 0",
      then_steps: ["notify"],
      else_steps: ["log"],
    };
    const form = formFromStep(stored, "");
    expect(form).toMatchObject({
      kind: "branch",
      when: "fetch.data.count > 0",
      thenSteps: ["notify"],
      elseSteps: ["log"],
    });
    const taken = ["fetch", "notify", "log"];
    expect(stepFromForm(form, stored, taken)).toEqual({ step: stored });
    expect(stepFromForm({ ...form, elseSteps: [] }, stored, taken)).toEqual({
      step: {
        id: "has-items",
        kind: "branch",
        when: "fetch.data.count > 0",
        then_steps: ["notify"],
      },
    });
  });

  test("a branch names what is missing or wrong", () => {
    const form = { ...formFromStep(null, CONNECTOR), kind: "branch" as const, name: "check" };
    const taken = ["notify", "log"];
    expect(stepFromForm(form, null, taken)).toEqual({ error: "whenMissing" });
    const withWhen = { ...form, when: "true" };
    expect(stepFromForm(withWhen, null, taken)).toEqual({ error: "thenMissing" });
    expect(stepFromForm({ ...withWhen, thenSteps: ["gone"] }, null, taken)).toEqual({
      error: "branchUnknownStep",
    });
    expect(
      stepFromForm({ ...withWhen, thenSteps: ["notify"], elseSteps: ["notify"] }, null, taken),
    ).toEqual({ error: "branchOverlap" });
  });

  test("a transform keeps its expression and its other settings", () => {
    const stored = { id: "shape", kind: "transform", expression: "return input;", timeout_ms: 500 };
    const form = formFromStep(stored, "");
    expect(form.code).toBe("return input;");
    expect(stepFromForm({ ...form, code: "return { a: 1 };" }, stored, [])).toEqual({
      step: { ...stored, expression: "return { a: 1 };" },
    });
    expect(stepFromForm({ ...form, code: " " }, stored, [])).toEqual({ error: "codeMissing" });
  });

  test("only steps the form can carry open in it; the rest opens as stored configuration", () => {
    expect(isFormStep(null)).toBe(true);
    expect(isFormStep({ id: "a", kind: "request", connector_id: CONNECTOR, path: "/x" })).toBe(
      true,
    );
    expect(isFormStep({ id: "a", kind: "branch", when: "true", then_steps: ["b"] })).toBe(true);
    expect(isFormStep({ id: "a", kind: "request", sql: { query: "select 1" } })).toBe(false);
    expect(isFormStep({ id: "a", kind: "request", url: "https://example.com" })).toBe(false);
    expect(isFormStep({ id: "a", kind: "request", connector_id: CONNECTOR, method: "HEAD" })).toBe(
      false,
    );
    expect(isFormStep({ id: "a", kind: "transform", language: "readability" })).toBe(false);
    expect(isFormStep({ id: "a", kind: "loop", over: "x", body: [] })).toBe(false);
  });

  test("a name with spaces becomes one with dashes", () => {
    const form = { ...formFromStep(null, CONNECTOR), kind: "transform" as const, name: "Clean up" };
    expect(stepFromForm(form, null, [])).toMatchObject({ step: { id: "clean-up" } });
  });
});

describe("step key from a plain name", () => {
  test("a plain name becomes a stable key that never collides", () => {
    expect(stepKeyFromName("Offene Pull Requests holen", "request", [])).toBe(
      "offene_pull_requests_holen",
    );
    expect(stepKeyFromName("Grüße senden", "request", [])).toBe("grusse_senden");
    expect(stepKeyFromName("  ", "transform", [])).toBe("transform");
    expect(stepKeyFromName("Senden", "request", ["senden", "senden_2"])).toBe("senden_3");
  });
});
