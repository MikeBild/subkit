// chat-first scanner — guards the CHAT-FIRST CONTRACT.
//
// The conversation IS the operator surface. The assistant must call
// tools, not instruct the user to run shell commands or open URLs in
// their browser. This scanner catches the most common violations:
//
//   1. Fenced bash/sh/shell/zsh/console blocks containing `curl`
//      ("paste this curl into your terminal"). Subkit's HTTP driver
//      can do the same call as a tool — there is no reason to send
//      the user out of chat.
//   2. Fenced bash blocks that declare a `$ ` prompt or contain
//      `cd …`, `export …`, `npm run …`, `node …`, `psql …`. These
//      are all "go run this elsewhere" instructions.
//   3. Free-prose "run / execute / paste / open / kopiere / führe …
//      this in your terminal / browser / shell / console" sentences.
//
// `sk` invocations are governed by the existing cliScanner. This
// scanner ignores them — `sk` is the in-product CLI; recommending `sk
// auth login` is not a chat-first violation per se (although the
// surrounding prompt rules still discourage it).
//
// Mode behaviour:
//   - soft (default): the offending fenced block or sentence is
//     replaced with `[guard:chat_first]` so the user sees the gap and
//     the model sees on the next turn that the workaround did not
//     survive. Violations are recorded for analytics.
//   - hard (CI / scenario): the orchestrator throws on the first
//     violation, failing the test that proved the model violated the
//     contract.

import type { Scanner, Violation } from "../types.ts";

const FENCED_RE = /```(bash|sh|shell|zsh|console|terminal)?\s*\n([\s\S]*?)```/g;

// Two-step match: an imperative trigger (run/execute/paste/open/
// führe/öffne/kopiere/starte) somewhere in the sentence AND a
// terminal/browser/shell mention somewhere else in the same sentence.
// Two regexes is more readable and more permissive than one giant
// alternation that has to nail token order.
const TRIGGER_RE =
  /\b(?:run|execute|paste|copy|open|navigate|head|kopiere|öffne|starte|führe(?:\s+aus)?|gib(?:\s+ein)?)\b/i;
const SURFACE_RE =
  /\b(?:into|in|to|in (?:your|deinem|deinen|the))\s+(?:your\s+|deinem\s+|deinen\s+|the\s+)?(?:terminal|browser|shell|console|konsole|terminalfenster|terminalfensters?|kommandozeile|cmd|powershell|bash)\b/i;

const SHELL_HEAD_TOKENS = new Set([
  "curl",
  "wget",
  "httpie",
  "http",
  "psql",
  "mongosh",
  "redis-cli",
  "node",
  "ts-node",
  "deno",
  "bun",
  "npm",
  "pnpm",
  "yarn",
  "npx",
  "bunx",
  "docker",
  "kubectl",
  "git",
  "ssh",
  "scp",
  "aws",
  "gcloud",
  "az",
  "doctl",
  "terraform",
  "make",
  "cd",
  "export",
  "cat",
  "grep",
  "sed",
  "awk",
  "tail",
  "head",
  "less",
  "vim",
  "nano",
]);

function inspectFencedBlock(body: string): { kind: string; cmd: string } | null {
  // Strip line continuations and comments so a one-line read of each
  // statement gets the head token cleanly.
  const segments = body
    .replace(/\\\n/g, " ")
    .split(/[\n;]|(?:&&|\|\||\|)/)
    .map((s) =>
      s
        .replace(/^[\s$#>]+/, "")
        .replace(/#[^\n]*$/, "")
        .trim(),
    )
    .filter((s) => s.length > 0);
  for (const segment of segments) {
    const head = segment.split(/\s+/)[0]?.toLowerCase();
    if (!head) continue;
    // sk is the in-product CLI; cliScanner owns those violations.
    if (head === "sk" || head === "subkit") continue;
    // The sk CLI installer is the ONE grounded curl one-liner
    // (`curl -fsSL <engine_url>/install | bash`) — bootstrapping the CLI has
    // no in-chat tool equivalent, so it is exempt from the chat-first push
    // rule. Narrowly scoped to the engine's own `/install` endpoint.
    if (head === "curl" && /\/install(?:$|[\s/?])/.test(segment)) continue;
    if (head === "curl") return { kind: "chat_first.curl_in_chat", cmd: segment.slice(0, 200) };
    if (SHELL_HEAD_TOKENS.has(head)) {
      return { kind: "chat_first.shell_command_in_chat", cmd: segment.slice(0, 200) };
    }
  }
  return null;
}

export const chatFirstScanner: Scanner = {
  id: "chat_first",
  scan(text: string): Violation[] {
    const out: Violation[] = [];

    FENCED_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop.
    while ((m = FENCED_RE.exec(text)) !== null) {
      const fullStart = m.index;
      const fullEnd = m.index + m[0].length;
      const body = m[2] ?? "";
      const lang = (m[1] ?? "").toLowerCase();
      const violation = inspectFencedBlock(body);
      if (!violation) continue;
      // For un-tagged fences (no language hint), only flag when the
      // body starts with a recognised shell head token. JSON/YAML/Text
      // fences without a language hint are common and benign.
      if (!lang && !violation) continue;
      out.push({
        kind: violation.kind,
        message:
          violation.kind === "chat_first.curl_in_chat"
            ? "The assistant told the user to run a curl command. The chat-first contract requires calling the equivalent tool (author_workflow / save_connector_draft / dry_run_step) instead of pushing the user to an external terminal."
            : "The assistant pasted a shell command for the user to execute. The chat-first contract requires calling the equivalent tool instead of pushing work into an external terminal.",
        span: { start: fullStart, end: fullEnd },
        details: { command_head: violation.cmd.split(/\s+/)[0] ?? null },
      });
    }

    // Prose sentences telling the user to run something in their
    // terminal/browser. A sentence is flagged when both an imperative
    // trigger AND a surface mention land in the same sentence.
    const sentenceRe = /[^.!?\n]+[.!?]?/g;
    let s: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop.
    while ((s = sentenceRe.exec(text)) !== null) {
      const sentence = s[0];
      if (!TRIGGER_RE.test(sentence)) continue;
      if (!SURFACE_RE.test(sentence)) continue;
      const start = s.index;
      const end = s.index + sentence.length;
      out.push({
        kind: "chat_first.run_in_terminal_instruction",
        message:
          "The assistant told the user to run / paste / open something in their terminal or browser. The chat-first contract requires invoking a tool instead.",
        span: { start, end },
        details: { match: sentence.trim().slice(0, 200) },
      });
    }

    return out;
  },
};
