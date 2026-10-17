import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { LearningSchema } from "../api/agent-sessions.ts";
import type { Db } from "../db/client.ts";
import * as invokeModule from "../llm/core/invoke.ts";
import {
  analyzeAgentSession,
  learningFingerprint,
  learningPattern,
  proposeLearning,
  redactLearning,
  sampleTranscript,
  transcriptLineText,
} from "./sessions.ts";

const FAKE_PAT = ["ghp", "abcdefghijklmnopqrstuvwxyz0123456789"].join("_");

const untouchableDb = new Proxy(
  {},
  {
    get() {
      throw new Error("the database must not be touched");
    },
  },
) as Db;

function invokeReturning(learnings: unknown[]) {
  return spyOn(invokeModule, "invoke").mockResolvedValue({
    object: { learnings },
  } as unknown as Awaited<ReturnType<typeof invokeModule.invoke>>);
}

afterEach(() => {
  (invokeModule.invoke as unknown as { mockRestore?: () => void }).mockRestore?.();
});

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

describe("redactLearning", () => {
  test("masks a token in title, body and pitfalls", () => {
    const result = redactLearning({
      title: `Push with ${FAKE_PAT}`,
      body: `Authenticate using ${FAKE_PAT} before pushing.`,
      pitfalls: [`never echo ${FAKE_PAT}`],
    });
    if (result.kind !== "kept") throw new Error("expected the learning to be kept");
    expect(JSON.stringify(result)).not.toContain(FAKE_PAT);
    expect(result.title).toContain("***REDACTED:pat***");
    expect(result.body).toContain("***REDACTED:pat***");
    expect(result.pitfalls[0]).toContain("***REDACTED:pat***");
  });

  test("drops a learning that names a key file location", () => {
    expect(
      redactLearning({
        title: "Engine master key",
        body: "The master key is stored at /etc/subkit/master.key on the host.",
        pitfalls: [],
      }),
    ).toEqual({ kind: "dropped" });
  });

  test("drops when only a pitfall names the location", () => {
    expect(
      redactLearning({ title: "Deploy", body: "Deploy via the script.", pitfalls: ["~/.ssh"] }),
    ).toEqual({ kind: "dropped" });
  });

  test("keeps an ordinary learning unchanged", () => {
    const learning = {
      title: "Halbgeviertstrich als Gedankenstrich",
      body: "Read config through process.env.FOO, never inline.",
      pitfalls: [],
    };
    expect(redactLearning(learning)).toEqual({ kind: "kept", ...learning });
  });
});

describe("proposeLearning redaction", () => {
  test("a key-path learning is dropped before anything is persisted", async () => {
    const result = await proposeLearning({
      tenant_id: "00000000-0000-4000-8000-000000000001",
      title: "TLS key",
      body: "The private key is /etc/ssl/private/server.key",
      domains: ["infra"],
      kind: "fact",
      actor: null,
      confidence: "high",
      evidence_summary: "agent=claude-code",
      db: untouchableDb,
    });
    expect(result).toEqual({ action: "dropped", candidate_id: null });
  });
});

describe("analyzeAgentSession redaction", () => {
  test("the extraction model receives the transcript with tokens masked", async () => {
    const spy = invokeReturning([]);
    const transcript = [
      JSON.stringify({ message: { role: "user", content: `my token is ${FAKE_PAT}` } }),
      `assistant: noted ${FAKE_PAT}`,
    ].join("\n");
    const result = await analyzeAgentSession({
      tenant_id: "00000000-0000-4000-8000-000000000001",
      transcript,
      meta: { agent: "claude-code", domains: ["infra"] },
      actor: null,
      db: untouchableDb,
    });
    expect(result).toEqual({ learnings_found: 0, proposed: 0, updated: 0, skipped: 0, dropped: 0 });
    expect(spy).toHaveBeenCalledTimes(1);
    const prompt = JSON.stringify(spy.mock.calls[0]?.[0]);
    expect(prompt).not.toContain(FAKE_PAT);
    expect(prompt).toContain("***REDACTED:pat***");
  });

  test("extracted key-path learnings are dropped and counted", async () => {
    invokeReturning([
      {
        title: "Deploy key",
        body: "Deploys use ~/.ssh/id_ed25519",
        kind: "fact",
        confidence: "high",
      },
    ]);
    const result = await analyzeAgentSession({
      tenant_id: "00000000-0000-4000-8000-000000000001",
      transcript: "user: the deploy key is in ~/.ssh",
      meta: { agent: "codex", domains: ["infra"] },
      actor: null,
      db: untouchableDb,
    });
    expect(result).toEqual({ learnings_found: 1, proposed: 0, updated: 0, skipped: 0, dropped: 1 });
  });
});
