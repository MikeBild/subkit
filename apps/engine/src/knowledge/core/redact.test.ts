import { describe, expect, test } from "bun:test";
import { redactBundleFiles, redactKnowledgeText } from "./redact.ts";

const SIGNED = "https://files.example.test/a.pdf?X-Amz-Signature=abc123&x=1";

describe("redactKnowledgeText", () => {
  test("a secret-shaped value is removed and counted", () => {
    const out = redactKnowledgeText(`Download from ${SIGNED} today.`);
    expect(out.text).not.toContain("abc123");
    expect(out.text).toContain("Download from");
    expect(out.redactions).toBeGreaterThan(0);
  });

  test("plain text passes through unchanged", () => {
    expect(redactKnowledgeText("Refunds need a second approver.")).toEqual({
      text: "Refunds need a second approver.",
      redactions: 0,
    });
  });
});

describe("redactBundleFiles", () => {
  test("only files with a secret are rewritten and the total is counted", () => {
    const clean = { path: "/a.md", content: "plain" };
    const dirty = { path: "/b.md", content: `see ${SIGNED}` };
    const out = redactBundleFiles([clean, dirty]);
    expect(out.files[0]).toBe(clean);
    expect(out.files[1]?.path).toBe("/b.md");
    expect(out.files[1]?.content).not.toContain("abc123");
    expect(out.redactions).toBeGreaterThan(0);
  });

  test("an empty bundle stays empty", () => {
    expect(redactBundleFiles([])).toEqual({ files: [], redactions: 0 });
  });
});
