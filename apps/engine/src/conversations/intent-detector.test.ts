// Tests for the conversation loop's user-intent detector.
//
// Covers the specific failure modes from sessions ba4e8898 / f44bf9b4:
//   • "führe ... aus" must force run_workflow, not narrate
//   • a long narrative user message must NOT get hijacked
//   • "approve" alone resolves a pending envelope
//
// The loop layer wires these signals — tests here only exercise the
// pure classifier so failures are easy to pinpoint.

import { describe, expect, test } from "bun:test";
import { detectEnvelopeResolution, detectUserIntent } from "./intent-detector.ts";

describe("detectUserIntent", () => {
  test("recognizes German 'führe ... aus' as run intent", () => {
    const res = detectUserIntent("führe meine github workflow aus");
    expect(res.forceTool).toBe("run_workflow");
    expect(res.reason).toBe("explicit_run_intent");
  });

  test("recognizes 'run' verb + tool noun as run intent", () => {
    const res = detectUserIntent("please run this workflow");
    expect(res.forceTool).toBe("run_workflow");
  });

  test("recognizes bare 'ausführen' as run intent", () => {
    const res = detectUserIntent("ausführen");
    expect(res.forceTool).toBe("run_workflow");
  });

  test("recognizes 'welche workflows habe ich' as enumeration → force no-tools", () => {
    const res = detectUserIntent("welche workflows habe ich");
    expect(res.forceTool).toBeUndefined();
    expect(res.forceNoTools).toBe(true);
    expect(res.reason).toBe("enumeration_answer_from_snapshot");
  });

  test("recognizes 'zeige alle meine workflows' as enumeration → force no-tools", () => {
    const res = detectUserIntent("zeige alle meine workflows");
    expect(res.forceNoTools).toBe(true);
  });

  test("recognizes 'wieviele connectors habe ich' as enumeration → force no-tools", () => {
    const res = detectUserIntent("wieviele connectors habe ich");
    expect(res.forceNoTools).toBe(true);
  });

  test("'wieviele executions' is NOT enumeration — executions are not in the snapshot", () => {
    const res = detectUserIntent("wieviele executions gibt es?");
    expect(res.forceNoTools).toBeUndefined();
    expect(res.forceTool).toBeUndefined();
    expect(res.reason).toBe("no_strong_intent");
  });

  test("recognizes 'speichere den workflow' as commit intent", () => {
    const res = detectUserIntent("speichere den aktualisierten workflow");
    expect(res.forceTool).toBe("commit_draft");
  });

  test("returns no_strong_intent for ambiguous narrative", () => {
    const res = detectUserIntent(
      "ich glaube der Filter ist schon korrekt, vielleicht sollte ich nochmal schauen",
    );
    expect(res.forceTool).toBeUndefined();
    expect(res.reason).toBe("no_strong_intent");
  });

  test("returns no_user_text for null input", () => {
    expect(detectUserIntent(null).reason).toBe("no_user_text");
    expect(detectUserIntent(undefined).reason).toBe("no_user_text");
  });
});

describe("detectEnvelopeResolution", () => {
  test("resolves 'approve' to approve", () => {
    expect(detectEnvelopeResolution("approve")).toBe("approve");
    expect(detectEnvelopeResolution("ok")).toBe("approve");
    expect(detectEnvelopeResolution("ja")).toBe("approve");
    expect(detectEnvelopeResolution("yes")).toBe("approve");
    expect(detectEnvelopeResolution("bestätige")).toBe("approve");
  });

  test("resolves 'reject' to reject", () => {
    expect(detectEnvelopeResolution("reject")).toBe("reject");
    expect(detectEnvelopeResolution("nein")).toBe("reject");
    expect(detectEnvelopeResolution("cancel")).toBe("reject");
    expect(detectEnvelopeResolution("abbrechen")).toBe("reject");
  });

  test("ignores long messages (not a one-word ack)", () => {
    expect(
      detectEnvelopeResolution(
        "ja aber bevor du das ausführst solltest du noch überlegen ob das korrekt ist",
      ),
    ).toBeNull();
  });

  test("ignores unrelated text", () => {
    expect(detectEnvelopeResolution("was ist der status?")).toBeNull();
    expect(detectEnvelopeResolution("zeige mir details")).toBeNull();
  });

  test("handles null / empty input", () => {
    expect(detectEnvelopeResolution(null)).toBeNull();
    expect(detectEnvelopeResolution("")).toBeNull();
    expect(detectEnvelopeResolution("   ")).toBeNull();
  });
});
