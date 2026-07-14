import { describe, expect, test } from "bun:test";
import { learningFingerprint, sampleTranscript, transcriptLineText } from "./sessions.ts";

describe("learningFingerprint", () => {
  test("normalizes whitespace and case in the title", () => {
    const a = learningFingerprint(["blog-de"], "Halbgeviertstrich  als   Gedankenstrich");
    const b = learningFingerprint(["blog-de"], "halbgeviertstrich als gedankenstrich ");
    expect(a).toBe(b);
  });

  test("is domain-order independent", () => {
    const a = learningFingerprint(["blog-de", "infra"], "Regel");
    const b = learningFingerprint(["infra", "blog-de"], "Regel");
    expect(a).toBe(b);
  });

  test("different domains yield different fingerprints", () => {
    expect(learningFingerprint(["blog-de"], "Regel")).not.toBe(
      learningFingerprint(["infra"], "Regel"),
    );
  });
});

describe("transcriptLineText", () => {
  test("passes plain text through", () => {
    expect(transcriptLineText("just a plain line")).toBe("just a plain line");
  });

  test("extracts role + string content from a message envelope", () => {
    const line = JSON.stringify({ message: { role: "user", content: "nie ASCII-Umlaute" } });
    expect(transcriptLineText(line)).toBe("user: nie ASCII-Umlaute");
  });

  test("joins text blocks from array content", () => {
    const line = JSON.stringify({
      message: { role: "assistant", content: [{ type: "text", text: "ok" }, { type: "tool_use" }] },
    });
    expect(transcriptLineText(line)).toBe("assistant: ok");
  });

  test("returns null for structural lines without text", () => {
    const line = JSON.stringify({ type: "progress", message: { content: [{ type: "tool_use" }] } });
    expect(transcriptLineText(line)).toBeNull();
    expect(transcriptLineText("")).toBeNull();
  });

  test("keeps an unparseable JSON-ish line verbatim", () => {
    expect(transcriptLineText("{broken json")).toBe("{broken json");
  });
});

describe("sampleTranscript", () => {
  test("short transcripts pass through untruncated", () => {
    const t = "user: hallo\nassistant: hi";
    expect(sampleTranscript(t)).toBe(t);
  });

  test("long transcripts keep head and tail with a truncation marker", () => {
    const head = "HEADMARK ".repeat(1000);
    const middle = "x".repeat(60_000);
    const tail = "TAILMARK ".repeat(1000);
    const sampled = sampleTranscript(`${head}\n${middle}\n${tail}`);
    expect(sampled).toContain("HEADMARK");
    expect(sampled).toContain("TAILMARK");
    expect(sampled).toContain("[…transcript truncated…]");
    expect(sampled.length).toBeLessThan(30_000);
  });
});
