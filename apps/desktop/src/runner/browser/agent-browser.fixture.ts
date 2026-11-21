import { writeFileSync } from "node:fs";

const [, , mcp, call, tool, json, toolsFlag, toolsValue] = process.argv;
const version = process.env.FAKE_AGENT_BROWSER_VERSION ?? "0.43.0";

function answer(response: unknown, isError = false): void {
  process.stdout.write(
    `${JSON.stringify({
      _meta: { agentBrowserVersion: version },
      isError,
      structuredContent: { response },
    })}\n`,
  );
}

if (mcp !== "mcp" || call !== "call" || toolsFlag !== "--tools" || toolsValue !== "all") {
  process.stdout.write(`${JSON.stringify({ error: { message: "bad argv" } })}\n`);
  process.exit(2);
}

const args = JSON.parse(json ?? "{}") as Record<string, unknown>;

if (tool === "agent_browser_wait_ms") {
  const marker = process.env.FAKE_AGENT_BROWSER_PID_FILE;
  if (marker) writeFileSync(marker, String(process.pid));
  setTimeout(() => answer({ success: true, data: {} }), Number(args.ms));
} else if (tool === "agent_browser_env") {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => name.startsWith("AGENT_BROWSER_") || name === "HOME",
    ),
  );
  answer({ success: true, data: { env, cwd: process.cwd(), args } });
} else if (tool === "agent_browser_fail") {
  answer({ success: false, data: null, error: "Element @e9 not found", code: "not_found" }, true);
} else if (tool === "agent_browser_garbage") {
  process.stdout.write("not json\n");
} else if (tool === "agent_browser_huge") {
  process.stdout.write("x".repeat(Number(args.bytes)));
} else {
  answer({ success: true, data: { tool, args } });
}
