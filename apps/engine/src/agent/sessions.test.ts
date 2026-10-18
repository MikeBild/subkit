import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { LearningSchema } from "../api/agent-sessions.ts";
import type { Db } from "../db/client.ts";
import * as invokeModule from "../llm/core/invoke.ts";
import {
  analyzeAgentSession,
  collectSessionLearning,
  learningBody,
  redactLearning,
  sampleTranscript,
  transcriptLineText,
  transcriptSessionId,
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

describe("learning kind", () => {
  test("the extraction schema classifies events and secrets so they are not collected", () => {
    const base = { title: "t", body: "b", confidence: "high" as const };
    expect(LearningSchema.safeParse(base).success).toBe(false);
    for (const kind of ["practice", "fact", "event", "secret"])
      expect(LearningSchema.safeParse({ ...base, kind }).success).toBe(true);
    expect(LearningSchema.safeParse({ ...base, kind: "opinion" }).success).toBe(false);
  });
});

describe("learningBody", () => {
  test("keeps pitfalls in the collected text", () => {
    expect(learningBody({ body: "Rule.  ", pitfalls: ["first", "second"] })).toBe(
      "Rule.\n\nPitfalls:\n- first\n- second",
    );
    expect(learningBody({ body: "Rule.", pitfalls: [] })).toBe("Rule.");
  });
});

describe("transcriptSessionId", () => {
  test("a session without an id gets a stable id from its transcript", () => {
    expect(transcriptSessionId("user: a")).toBe(transcriptSessionId("user: a"));
    expect(transcriptSessionId("user: a")).not.toBe(transcriptSessionId("user: b"));
    expect(transcriptSessionId("user: a")).toMatch(/^transcript-[a-f0-9]{32}$/);
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

describe("collectSessionLearning redaction", () => {
  test("a key-path learning is dropped before anything is persisted", async () => {
    const result = await collectSessionLearning({
      tenant_id: "00000000-0000-4000-8000-000000000001",
      title: "TLS key",
      body: "The private key is /etc/ssl/private/server.key",
      kind: "fact",
      actor: null,
      session: { agent: "claude-code", session_id: "s-1", domains: ["infra"] },
      evidence_excerpt: "agent=claude-code",
      db: untouchableDb,
    });
    expect(result).toEqual({ outcome: "dropped", intake_item_id: null });
  });

  test("evidence naming a key location drops the learning too", async () => {
    const result = await collectSessionLearning({
      tenant_id: "00000000-0000-4000-8000-000000000001",
      title: "Deploy",
      body: "Deploy through the release script.",
      kind: "practice",
      actor: null,
      session: { agent: "codex", session_id: "s-2", domains: ["infra"] },
      evidence_excerpt: "user: the key is in ~/.ssh/id_ed25519",
      db: untouchableDb,
    });
    expect(result).toEqual({ outcome: "dropped", intake_item_id: null });
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
    expect(result).toEqual({
      learnings_found: 0,
      collected: 0,
      evidence_appended: 0,
      replayed: 0,
      dropped: 0,
      not_collected: 0,
    });
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
    expect(result).toEqual({
      learnings_found: 1,
      collected: 0,
      evidence_appended: 0,
      replayed: 0,
      dropped: 1,
      not_collected: 0,
    });
  });

  test("events and secrets are classified out and never collected", async () => {
    const spy = invokeReturning([
      {
        title: "Release pushed",
        body: "9.9.9 is pushed and green.",
        kind: "event",
        confidence: "high",
      },
      { title: "Fallback key", body: "A fallback key exists.", kind: "secret", confidence: "high" },
    ]);
    const result = await analyzeAgentSession({
      tenant_id: "00000000-0000-4000-8000-000000000001",
      transcript: "user: release is out",
      meta: { agent: "codex", domains: ["infra"] },
      actor: null,
      db: untouchableDb,
    });
    expect(result).toEqual({
      learnings_found: 2,
      collected: 0,
      evidence_appended: 0,
      replayed: 0,
      dropped: 0,
      not_collected: 2,
    });
    const prompt = JSON.stringify(spy.mock.calls[0]?.[0]);
    expect(prompt).toContain("kind=event");
    expect(prompt).toContain("kind=secret");
    expect(prompt).not.toContain("Practices become skills");
  });
});
