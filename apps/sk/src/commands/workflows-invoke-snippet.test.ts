// `sk workflows invoke-snippet` prints the shared renderer's output for the
// profile's engine URL — the same bytes the engine hands the workflow page
// for the same inputs. The command stays offline: it formats, it never calls.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { INVOKE_SNIPPET_LANGUAGES, renderInvokeSnippet } from "@shared/invoke-snippet.ts";
import { runCommand } from "citty";
import { workflowsCommand } from "./workflows.ts";

const ENGINE = "https://engine.example.com";
const WORKFLOW = "3fb5fc90-1c2d-4e5f-8a6b-7c8d9e0f1a2b";

let written: string[];
let restore: () => void;

beforeEach(() => {
  // The profile comes from the environment, so the test never reads or
  // writes a config file on disk.
  const overrides = {
    SUBKIT_ENGINE_URL: ENGINE,
    SUBKIT_API_KEY: "wf_live_never_printed",
    SUBKIT_TENANT: "tenant-never-printed",
  };
  const saved = Object.fromEntries(
    Object.keys(overrides).map((key) => [key, process.env[key]] as const),
  );
  Object.assign(process.env, overrides);
  written = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    written.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stdout.write;
  restore = () => {
    process.stdout.write = original;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
});

afterEach(() => restore());

async function emit(...args: string[]): Promise<{ snippet: string; environment: string }> {
  await runCommand(workflowsCommand, {
    rawArgs: ["invoke-snippet", WORKFLOW, "--json", ...args],
  });
  return JSON.parse(written.join("")) as { snippet: string; environment: string };
}

describe("sk workflows invoke-snippet", () => {
  test.each([...INVOKE_SNIPPET_LANGUAGES])("%s is the shared renderer's output", async (lang) => {
    const out = await emit("--lang", lang);
    expect(out.snippet).toBe(
      renderInvokeSnippet({ lang, engineUrl: ENGINE, workflowId: WORKFLOW, environment: "prod" }),
    );
  });

  test("production is the default and is stated", async () => {
    const out = await emit();
    expect(out.environment).toBe("prod");
    expect(out.snippet).toContain("x-subkit-environment: prod");
  });

  test("--environment dev targets development", async () => {
    const out = await emit("--environment", "dev");
    expect(out.environment).toBe("dev");
    expect(out.snippet).toContain("x-subkit-environment: dev");
  });

  test("neither the tenant header nor the key is printed", async () => {
    await emit();
    const all = written.join("");
    expect(all).not.toContain("x-subkit-tenant");
    expect(all).not.toContain("tenant-never-printed");
    expect(all).not.toContain("wf_live_never_printed");
  });
});
