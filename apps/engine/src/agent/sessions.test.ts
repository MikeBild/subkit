import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  LearningSchema,
  learningFingerprint,
  learningPattern,
  sampleTranscript,
  transcriptLineText,
} from "./sessions.ts";

describe("learningFingerprint", () => {
  test("normalizes whitespace and case in the title", () => {
    const a = learningFingerprint(
      ["blog-de"],
      "Halbgeviertstrich  als   Gedankenstrich",
      "practice",
    );
    const b = learningFingerprint(["blog-de"], "halbgeviertstrich als gedankenstrich ", "practice");
    expect(a).toBe(b);
  });

  test("is domain-order independent", () => {
    const a = learningFingerprint(["blog-de", "infra"], "Regel", "practice");
    const b = learningFingerprint(["infra", "blog-de"], "Regel", "practice");
    expect(a).toBe(b);
  });

  test("different domains yield different fingerprints", () => {
    expect(learningFingerprint(["blog-de"], "Regel", "practice")).not.toBe(
      learningFingerprint(["infra"], "Regel", "practice"),
    );
  });

  test("a practice keeps the fingerprint earlier decisions were recorded under", () => {
    const legacy = createHash("sha256").update("session_learning:blog-de:regel").digest("hex");
    expect(learningFingerprint(["blog-de"], "Regel", "practice")).toBe(legacy);
  });

  test("a fact and a practice with the same title are different proposals", () => {
    expect(learningFingerprint(["blog-de"], "Regel", "fact")).not.toBe(
      learningFingerprint(["blog-de"], "Regel", "practice"),
    );
  });
});

describe("learning kind", () => {
  test("a fact becomes knowledge, a practice stays a skill", () => {
    expect(learningPattern("fact")).toBe("knowledge_learning");
    expect(learningPattern("practice")).toBe("session_learning");
  });

  test("the extraction schema requires a kind and accepts only the two", () => {
    const base = { title: "t", body: "b", confidence: "high" as const };
    expect(LearningSchema.safeParse(base).success).toBe(false);
    expect(LearningSchema.safeParse({ ...base, kind: "fact" }).success).toBe(true);
    expect(LearningSchema.safeParse({ ...base, kind: "opinion" }).success).toBe(false);
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
