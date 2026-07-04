// chat-first scanner tests — locks the no-curl-no-shell-no-run-this-yourself
// contract that the CHAT-FIRST CONTRACT block in the system prompt
// asserts in prose. Without this scanner, the model occasionally falls
// through to "paste this curl into your terminal" which breaks the
// only-surface-is-this-chat invariant.

import { describe, expect, it } from "bun:test";
import { chatFirstScanner } from "../scanners/chat-first.ts";

const ctx = {};

function bash(...lines: string[]): string {
  return ["```bash", ...lines, "```"].join("\n");
}

describe("chatFirstScanner — fenced shell blocks", () => {
  it("flags a curl block (the canonical violation)", () => {
    const text = bash('curl -H "Authorization: Bearer x" https://api.example.com/things');
    const vs = chatFirstScanner.scan(text, ctx);
    expect(vs.map((v) => v.kind)).toEqual(["chat_first.curl_in_chat"]);
    expect(vs[0]?.span).toBeDefined();
  });

  it("flags a curl block even with the `console` language tag", () => {
    const text = "```console\ncurl https://api.example.com/things\n```";
    const vs = chatFirstScanner.scan(text, ctx);
    expect(vs.map((v) => v.kind)).toContain("chat_first.curl_in_chat");
  });

  it("flags a non-curl shell command (e.g. docker, psql)", () => {
    const text = bash("docker run -p 8080:80 nginx");
    const vs = chatFirstScanner.scan(text, ctx);
    expect(vs.map((v) => v.kind)).toContain("chat_first.shell_command_in_chat");
  });

  it("does not flag `sk` invocations (cliScanner owns those)", () => {
    const text = bash("sk apikeys create --name demo");
    const vs = chatFirstScanner.scan(text, ctx);
    expect(vs).toEqual([]);
  });

  it("does not flag a fenced JSON block that happens to contain the word curl", () => {
    const text = '```json\n{\n  "description": "Use curl when developing locally"\n}\n```';
    const vs = chatFirstScanner.scan(text, ctx);
    expect(vs).toEqual([]);
  });

  it("flags a multi-statement bash block where any statement is curl", () => {
    const text = bash("echo 'preparing'", "curl https://api.example.com/things");
    const vs = chatFirstScanner.scan(text, ctx);
    // Either the echo (recognised as a generic shell head) or the
    // curl line should produce a violation; at least one must be the
    // curl_in_chat kind so the LLM gets the right diagnostic.
    expect(vs.some((v) => v.kind === "chat_first.curl_in_chat")).toBe(true);
  });
});

describe("chatFirstScanner — prose run-in-terminal instructions", () => {
  it("flags 'run this in your terminal' (English)", () => {
    const text = "Now run this command in your terminal: curl https://x.example.com.";
    const vs = chatFirstScanner.scan(text, ctx);
    expect(vs.map((v) => v.kind)).toContain("chat_first.run_in_terminal_instruction");
  });

  it("flags 'paste this in your shell' (English)", () => {
    const text = "Paste this into your shell to continue.";
    const vs = chatFirstScanner.scan(text, ctx);
    expect(vs.map((v) => v.kind)).toContain("chat_first.run_in_terminal_instruction");
  });

  it("flags 'führe das in deinem terminal aus' (German)", () => {
    const text = "Bitte führe das in deinem Terminal aus.";
    const vs = chatFirstScanner.scan(text, ctx);
    expect(vs.map((v) => v.kind)).toContain("chat_first.run_in_terminal_instruction");
  });

  it("flags 'open this URL in your browser'", () => {
    const text = "Open this URL in your browser to authorize.";
    const vs = chatFirstScanner.scan(text, ctx);
    expect(vs.map((v) => v.kind)).toContain("chat_first.run_in_terminal_instruction");
  });

  it("does not flag prose that mentions terminal but is not an instruction", () => {
    const text = "The terminal will display the result once the workflow finishes.";
    const vs = chatFirstScanner.scan(text, ctx);
    expect(vs).toEqual([]);
  });

  it("only blanks the offending sentence, not the whole paragraph", () => {
    const text =
      "I will now build the workflow for you. Please run this in your terminal: foo. The next step is to validate.";
    const vs = chatFirstScanner.scan(text, ctx);
    const violation = vs.find((v) => v.kind === "chat_first.run_in_terminal_instruction");
    expect(violation).toBeDefined();
    const span = violation?.span;
    expect(span).toBeDefined();
    expect(text.slice(span!.start, span!.end)).toContain("Please run this in your terminal");
    // Sentence-bounded, not full text.
    expect(span!.end - span!.start).toBeLessThan(text.length);
  });
});
