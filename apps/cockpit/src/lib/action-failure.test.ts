import { afterEach, describe, expect, test } from "bun:test";
import {
  clearFailure,
  failureSnapshot,
  offerFailureRetry,
  offerMutationRetry,
  registerFailureHost,
  reportFailure,
  subscribeFailure,
} from "./action-failure";

afterEach(() => clearFailure());

describe("action failure", () => {
  test("keeps the latest failure with its cause until it is cleared", () => {
    const cause = new Error("boom");
    reportFailure("Speichern fehlgeschlagen", cause);
    reportFailure("Start fehlgeschlagen", cause, { body: "Der Run wurde nicht gestartet." });
    expect(failureSnapshot().failure?.title).toBe("Start fehlgeschlagen");
    expect(failureSnapshot().failure?.body).toBe("Der Run wurde nicht gestartet.");
    expect(failureSnapshot().failure?.error).toBe(cause);
    clearFailure();
    expect(failureSnapshot().failure).toBeNull();
  });

  test("the place opened last shows it, and gives it back when it closes", () => {
    const page = registerFailureHost();
    expect(failureSnapshot().host).toBe(page.id);
    const dialog = registerFailureHost();
    expect(failureSnapshot().host).toBe(dialog.id);
    dialog.release();
    expect(failureSnapshot().host).toBe(page.id);
    page.release();
    expect(failureSnapshot().host).toBeNull();
  });

  test("tells listeners about every change", () => {
    let calls = 0;
    const stop = subscribeFailure(() => {
      calls += 1;
    });
    reportFailure("Fehler");
    clearFailure();
    clearFailure();
    stop();
    reportFailure("Fehler");
    expect(calls).toBe(2);
  });
});

describe("where a failure is shown", () => {
  test("a dialog outranks the page, the page outranks the shell, whatever opened first", () => {
    const page = registerFailureHost("page");
    const shell = registerFailureHost("base");
    expect(failureSnapshot().host).toBe(page.id);
    const dialog = registerFailureHost("overlay");
    const later = registerFailureHost("page");
    expect(failureSnapshot().host).toBe(dialog.id);
    dialog.release();
    expect(failureSnapshot().host).toBe(later.id);
    later.release();
    page.release();
    expect(failureSnapshot().host).toBe(shell.id);
    shell.release();
  });

  test("a failure with a scope goes to the section that owns it", () => {
    const page = registerFailureHost("page");
    const section = registerFailureHost("page", "schedule");
    reportFailure("Speichern fehlgeschlagen", undefined, { scope: "schedule" });
    expect(failureSnapshot().host).toBe(section.id);
    reportFailure("Start fehlgeschlagen");
    expect(failureSnapshot().host).toBe(page.id);
    section.release();
    reportFailure("Speichern fehlgeschlagen", undefined, { scope: "schedule" });
    expect(failureSnapshot().host).toBe(page.id);
    page.release();
  });

  test("a failed action offers its own repeat, an explicit one wins", () => {
    const cause = new Error("boom");
    let calls = "";
    offerFailureRetry(cause, () => {
      calls += "offered";
    });
    reportFailure("Fehler", cause);
    failureSnapshot().failure?.retry?.();
    reportFailure("Fehler", cause, {
      retry: () => {
        calls += "+explicit";
      },
    });
    failureSnapshot().failure?.retry?.();
    expect(calls).toBe("offered+explicit");
    reportFailure("Fehler", new Error("other"));
    expect(failureSnapshot().failure?.retry).toBeUndefined();
  });

  test("a sensitive mutation never leaves a repeat that holds its values", () => {
    const secret = new Error("rejected");
    let calls = 0;
    offerMutationRetry(secret, { sensitive: true }, () => {
      calls += 1;
    });
    reportFailure("Fehler", secret);
    expect(failureSnapshot().failure?.retry).toBeUndefined();
    const plain = new Error("rejected");
    offerMutationRetry(plain, { sensitive: false }, () => {
      calls += 1;
    });
    reportFailure("Fehler", plain);
    failureSnapshot().failure?.retry?.();
    const bare = new Error("rejected");
    offerMutationRetry(bare, undefined, () => {
      calls += 1;
    });
    reportFailure("Fehler", bare);
    failureSnapshot().failure?.retry?.();
    expect(calls).toBe(2);
  });

  test("a failure stays where it was shown when a dialog opens afterwards", () => {
    const page = registerFailureHost("page");
    reportFailure("Start fehlgeschlagen");
    const dialog = registerFailureHost("overlay");
    expect(failureSnapshot().host).toBe(page.id);
    reportFailure("Speichern fehlgeschlagen");
    expect(failureSnapshot().host).toBe(dialog.id);
    dialog.release();
    expect(failureSnapshot().host).toBe(page.id);
    page.release();
  });
});
