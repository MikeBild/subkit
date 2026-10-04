#!/usr/bin/env bun

interface Args {
  engineUrl: string;
  version: string;
  apiKey: string | undefined;
}

function usage(message: string): never {
  console.error(`verify:release: ${message}\n`);
  console.error(
    "usage: bun run verify:release -- --engine-url <url> --version <x.y.z> [--api-key <key>]",
  );
  process.exit(2);
}

function parseArgs(argv: string[]): Args {
  let engineUrl = process.env.SK_ENGINE_URL ?? "";
  let version = "";
  let apiKey = process.env.SK_API_KEY;
  for (let i = 0; i < argv.length; i++) {
    const next = argv[i + 1];
    switch (argv[i]) {
      case "--engine-url":
        if (!next) usage("--engine-url needs a value");
        engineUrl = next;
        i++;
        break;
      case "--version":
        if (!next) usage("--version needs a value");
        version = next;
        i++;
        break;
      case "--api-key":
        if (!next) usage("--api-key needs a value");
        apiKey = next;
        i++;
        break;
      default:
        usage(`unknown argument: ${argv[i]}`);
    }
  }
  if (!engineUrl) usage("no engine url (--engine-url or SK_ENGINE_URL)");
  if (!version) usage("no expected version (--version)");
  return { engineUrl: engineUrl.replace(/\/+$/, ""), version, apiKey };
}

type Status = "PASS" | "FAIL" | "SKIP";
const results: Array<{ status: Status; id: string; detail: string }> = [];
function record(status: Status, id: string, detail: string): void {
  results.push({ status, id, detail });
  console.log(`${status.padEnd(4)} ${id.padEnd(22)} ${detail}`);
}

async function getJson(url: string, headers: Record<string, string> = {}): Promise<unknown> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const args = parseArgs(process.argv.slice(2));
console.log(`verify:release: expecting ${args.version} at ${args.engineUrl}\n`);

try {
  const health = (await getJson(`${args.engineUrl}/health`)) as {
    status?: string;
    service?: string;
    version?: string;
  };
  const ready = (await getJson(`${args.engineUrl}/ready`)) as {
    status?: string;
    service?: string;
    version?: string;
    checks?: { lifecycle?: string; database?: string };
  };
  record(
    health.status === "ok" && health.service === "subkit" ? "PASS" : "FAIL",
    "health.contract",
    `status=${health.status ?? "(missing)"} service=${health.service ?? "(missing)"}`,
  );
  record(
    ready.status === "ready" &&
      ready.service === "subkit" &&
      ready.version === args.version &&
      ready.checks?.lifecycle === "pass" &&
      ready.checks?.database === "pass"
      ? "PASS"
      : "FAIL",
    "ready.contract",
    `status=${ready.status ?? "(missing)"} service=${ready.service ?? "(missing)"} lifecycle=${ready.checks?.lifecycle ?? "(missing)"} database=${ready.checks?.database ?? "(missing)"}`,
  );
  record(
    health.version === args.version ? "PASS" : "FAIL",
    "health.version",
    `${health.version ?? "(missing)"} (expected ${args.version})`,
  );
} catch (err) {
  record("FAIL", "health", `unreachable — ${err instanceof Error ? err.message : String(err)}`);
}

try {
  const doc = (await getJson(`${args.engineUrl}/openapi.json`)) as {
    info?: { version?: string };
  };
  const served = doc.info?.version;
  record(
    served === args.version ? "PASS" : "FAIL",
    "openapi.version",
    `${served ?? "(missing)"} (expected ${args.version})`,
  );
} catch (err) {
  record("FAIL", "openapi.version", err instanceof Error ? err.message : String(err));
}

if (!args.apiKey) {
  record("SKIP", "mcp.version", "no --api-key / SK_API_KEY — MCP initialize needs a principal");
} else {
  try {
    const res = await fetch(`${args.engineUrl}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${args.apiKey}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "sk-verify-release", version: "1" },
        },
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = await res.text();
    const jsonText = raw.includes("data:")
      ? (raw
          .split("\n")
          .find((l) => l.startsWith("data:"))
          ?.slice(5)
          .trim() ?? raw)
      : raw;
    const envelope = JSON.parse(jsonText) as {
      result?: { serverInfo?: { name?: string; version?: string } };
    };
    const served = envelope.result?.serverInfo?.version;
    record(
      served === args.version ? "PASS" : "FAIL",
      "mcp.version",
      `serverInfo.version=${served ?? "(missing)"} (expected ${args.version})`,
    );
  } catch (err) {
    record("FAIL", "mcp.version", err instanceof Error ? err.message : String(err));
  }
}

const failed = results.filter((r) => r.status === "FAIL");
const skipped = results.filter((r) => r.status === "SKIP");
console.log(
  `\nverify:release: ${results.length - failed.length - skipped.length} passed, ` +
    `${failed.length} failed, ${skipped.length} skipped`,
);
if (skipped.length > 0) {
  console.log("verify:release: skipped checks were NOT verified.");
}
process.exit(failed.length > 0 ? 1 : 0);
