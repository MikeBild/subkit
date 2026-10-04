import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { invokeRunBody, renderInvokeSnippet, shellQuote } from "@shared/invoke-snippet.ts";

const WORKFLOW = "3fb5fc90-1c2d-4e5f-8a6b-7c8d9e0f1a2b";
const ENGINE = "https://engine.example.com";
const URL_SENT = `${ENGINE}/v1/executions`;
const HOSTILE_TEXT = 'it\'s $HOME `id` $(id) \\ back\\slash "quoted" \n tab\t ünï ✓ 😀';
const INPUT = JSON.parse(
  JSON.stringify({ note: HOSTILE_TEXT, "we'ird $key": [true, false, null, 1.5, "'"] }).replace(
    /}$/,
    ',"__proto__":{"nested":"kept"}}',
  ),
) as Record<string, unknown>;
const EXPECTED = JSON.stringify(invokeRunBody(WORKFLOW, INPUT));

const available = (command: string): boolean =>
  spawnSync(command, ["--version"], { encoding: "utf8" }).status === 0;

function curlArguments(command: string): string[] {
  const run = spawnSync("sh", ["-c", `curl() { printf '%s\\0' "$@"; }\n${command}`], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", HOME: "/expanded-home", SK_API_KEY: "placeholder-key" },
  });
  if (run.status !== 0) throw new Error(`sh failed: ${run.stderr}`);
  return run.stdout.split("\0").slice(0, -1);
}

describe("the curl snippet in a real shell", () => {
  test("curl receives the URL, the headers and one body word, unexpanded", () => {
    const args = curlArguments(
      renderInvokeSnippet({
        lang: "curl",
        engineUrl: ENGINE,
        workflowId: WORKFLOW,
        environment: "prod",
        input: INPUT,
      }),
    );
    expect(args).toEqual([
      "-sS",
      "-X",
      "POST",
      URL_SENT,
      "-H",
      "authorization: Bearer placeholder-key",
      "-H",
      "x-subkit-environment: prod",
      "-H",
      "content-type: application/json",
      "-d",
      EXPECTED,
    ]);
    expect(args.at(-1)).toContain("$HOME `id` $(id)");
    expect(args.at(-1)).not.toContain("/expanded-home");
  });

  test.each([
    "x'; echo injected; echo '",
    "$(echo injected)",
    "`echo injected`",
    "a b\tc\nd",
    "back\\slash",
  ])("shellQuote hands the shell exactly one word: %j", (value) => {
    expect(curlArguments(`curl ${shellQuote(value)}`)).toEqual([value]);
  });
});

describe("the python snippet in a real interpreter", () => {
  test.skipIf(!available("python3"))("requests.post is called with the input as written", () => {
    const dir = mkdtempSync(join(tmpdir(), "sk-invoke-snippet-"));
    try {
      writeFileSync(
        join(dir, "requests.py"),
        [
          "import sys",
          "class _Response:",
          "    def json(self):",
          "        return {}",
          "def post(url, headers=None, json=None):",
          '    dumps = __import__("json").dumps',
          '    sys.stdout.write(dumps({"url": url, "headers": headers, "json": json}) + "\\n")',
          "    return _Response()",
          "",
        ].join("\n"),
      );
      const run = spawnSync(
        "python3",
        [
          "-c",
          renderInvokeSnippet({
            lang: "python",
            engineUrl: ENGINE,
            workflowId: WORKFLOW,
            environment: "dev",
            input: INPUT,
          }),
        ],
        {
          encoding: "utf8",
          env: {
            PATH: process.env.PATH ?? "",
            PYTHONPATH: dir,
            PYTHONIOENCODING: "utf-8",
            SK_API_KEY: "placeholder-key",
          },
        },
      );
      if (run.status !== 0) throw new Error(`python3 failed: ${run.stderr}`);
      const call = JSON.parse(run.stdout.split("\n")[0] ?? "") as {
        url: string;
        headers: Record<string, string>;
        json: unknown;
      };
      expect(call.url).toBe(URL_SENT);
      expect(call.headers).toEqual({
        authorization: "Bearer placeholder-key",
        "x-subkit-environment": "dev",
        "content-type": "application/json",
      });
      expect(JSON.stringify(call.json)).toBe(EXPECTED);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
