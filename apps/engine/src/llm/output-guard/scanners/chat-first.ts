import type { Scanner, Violation } from "../types.ts";

const FENCED_RE = /```(bash|sh|shell|zsh|console|terminal)?\s*\n([\s\S]*?)```/g;

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
    if (head === "sk" || head === "subkit") continue;
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
