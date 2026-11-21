import { describe, expect, test } from "bun:test";
import {
  type ConfirmerFacts,
  confirmerRefusal,
  grantsConfirmation,
  LOCAL_CONFIRMATION_STATES,
  LOCAL_CONFIRMATION_WINDOW_MS,
  type LocalConfirmationEvent,
  type LocalConfirmationState,
  localConfirmationDeadline,
  localConfirmationStep,
  NOTHING_CHANGED,
  toolCallStateOf,
} from "./local-confirmation.ts";

const AT = new Date("2026-11-21T10:00:00.000Z");
const plus = (ms: number) => new Date(AT.getTime() + ms);

describe("the deadline of a local confirmation", () => {
  test("is 15 minutes after the request when nothing ends earlier", () => {
    expect(LOCAL_CONFIRMATION_WINDOW_MS).toBe(900_000);
    expect(localConfirmationDeadline(AT, [])).toEqual(plus(900_000));
    expect(localConfirmationDeadline(AT, [null, plus(900_001), null])).toEqual(plus(900_000));
    expect(localConfirmationDeadline(AT, [plus(900_000)])).toEqual(plus(900_000));
  });

  test("never outlasts the job, the task run or the command", () => {
    expect(localConfirmationDeadline(AT, [plus(60_000)])).toEqual(plus(60_000));
    expect(localConfirmationDeadline(AT, [plus(600_000), null, plus(300_000)])).toEqual(
      plus(300_000),
    );
    expect(localConfirmationDeadline(AT, [plus(300_000), plus(600_000)])).toEqual(plus(300_000));
    expect(localConfirmationDeadline(AT, [plus(-1)])).toEqual(plus(-1));
  });
});

describe("the state machine", () => {
  const deadline = plus(900_000);
  const cases: Array<
    [LocalConfirmationState, LocalConfirmationEvent, Date, ReturnType<typeof localConfirmationStep>]
  > = [
    ["requested", "grant", AT, { ok: true, state: "granted" }],
    ["requested", "decline", AT, { ok: true, state: "declined" }],
    ["requested", "grant", plus(899_999), { ok: true, state: "granted" }],
    ["requested", "grant", deadline, { ok: false, refusal: "expired" }],
    ["requested", "decline", deadline, { ok: false, refusal: "expired" }],
    ["requested", "expire", plus(899_999), { ok: false, refusal: "not_due" }],
    ["requested", "expire", deadline, { ok: true, state: "expired" }],
    ["requested", "expire", plus(900_001), { ok: true, state: "expired" }],
    ["granted", "grant", AT, { ok: false, refusal: "already_decided" }],
    ["granted", "expire", plus(900_001), { ok: false, refusal: "already_decided" }],
    ["declined", "grant", AT, { ok: false, refusal: "already_decided" }],
    ["expired", "grant", AT, { ok: false, refusal: "expired" }],
    ["expired", "expire", plus(900_001), { ok: false, refusal: "expired" }],
  ];
  for (const [state, event, now, expected] of cases) {
    test(`${state} + ${event} at +${now.getTime() - AT.getTime()} ms`, () => {
      expect(localConfirmationStep(state, event, deadline, now)).toEqual(expected);
    });
  }

  test("each state is the chat tool call's confirmation state, so there is one column", () => {
    expect(LOCAL_CONFIRMATION_STATES.map(toolCallStateOf)).toEqual([
      "proposed",
      "confirmed",
      "declined",
      "expired",
    ]);
  });

  test("only a resolved yes grants", () => {
    expect(grantsConfirmation("resolved", "confirmed")).toBe(true);
    expect(grantsConfirmation("resolved", "declined")).toBe(false);
    expect(grantsConfirmation("resolved", "ambiguous")).toBe(false);
    expect(grantsConfirmation("cancelled", "confirmed")).toBe(false);
    expect(grantsConfirmation("timeout", "confirmed")).toBe(false);
  });
});

describe("who may confirm", () => {
  const OWNER: ConfirmerFacts = {
    principal_kind: "user",
    auth_source: "browser_session",
    delegated: false,
    actor_id: "u1",
    owner_id: "u1",
    holds_local_confirm: true,
  };
  const cases: Array<[string, Partial<ConfirmerFacts>, ReturnType<typeof confirmerRefusal>]> = [
    ["the owner in a signed-in session", {}, null],
    ["a runner token", { auth_source: "device_runner" }, "device_runner"],
    [
      "a runner token, even for the owner without the permission",
      { auth_source: "device_runner", holds_local_confirm: false },
      "device_runner",
    ],
    ["a system account", { principal_kind: "system_account" }, "no_person"],
    ["nobody", { principal_kind: null }, "no_person"],
    ["a user without an id", { actor_id: null }, "no_person"],
    ["an API key", { auth_source: "api_key" }, "no_browser_session"],
    ["a task run", { auth_source: "task_run" }, "no_browser_session"],
    ["an unknown source", { auth_source: null }, "no_browser_session"],
    ["a delegated session", { delegated: true }, "no_browser_session"],
    ["someone else, even an admin", { actor_id: "u2" }, "not_owner"],
    ["a job without an owner", { owner_id: null }, "not_owner"],
    ["the owner without local:confirm", { holds_local_confirm: false }, "missing_permission"],
  ];
  for (const [name, facts, expected] of cases) {
    test(name, () => {
      expect(confirmerRefusal({ ...OWNER, ...facts })).toBe(expected);
    });
  }
});

test("the failure text is the same in every place", () => {
  expect(NOTHING_CHANGED).toEqual({
    de: "Es wurde nichts gesendet oder geändert.",
    en: "Nothing was sent or changed.",
  });
});
