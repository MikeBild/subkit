// User story: As a repo contributor, my `~/.sk/settings.json`
// sets sensible defaults, my `<project>/.sk/settings.json` adds
// project-specific context, and my `.sk/settings.local.json`
// carries machine-local overrides (API keys, paths). The three
// files merge user → project → local, with later files winning.
//
// Acceptance criteria:
//
//   AC1. Project settings override user defaults for string keys
//        (e.g. `model`, `defaultTenant`).
//   AC2. Local settings override project settings for the same keys.
//   AC3. `additionalDirectories` is deep-merged (project contributes,
//        local contributes, user contributes — latest wins for
//        non-array keys, but the array itself is replaced by the
//        deepest layer that defines it — confirms our deep-merge
//        semantics).
//   AC4. `includeMemoryFile: false` at any layer suppresses SUBKIT.md
//        injection when running headless.
//   AC5. Settings-driven `model` is attached to new conversations
//        (the `conversations.model` column gets the right value).
//   AC6. Missing files are tolerated — loader falls back to defaults.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { ResolvedProfile } from "../../../../sk/src/config.ts";
import { runHeadless } from "../../../../sk/src/headless.ts";
import { loadSettings } from "../../../../sk/src/settings.ts";
import { conversations } from "../../db/schema/index.ts";
import { createJourneyCtx, JOURNEY_HOOK_TIMEOUT, type JourneyCtx } from "./setup.ts";

let ctx: JourneyCtx;
let tmpWorkspace: string;
let prevSkHome: string | undefined;
let userHome: string;

const makeBuf = () => ({
  write: (_s: string) => {
    /* drop */
  },
});

function profile(): ResolvedProfile {
  return {
    name: "journey",
    engine_url: ctx.baseUrl,
    api_key: ctx.apiKey,
    active_tenant_id: ctx.tenantId,
  };
}

async function loadConversationModel(id: string): Promise<string | null> {
  const [row] = await ctx.db
    .select({ model: conversations.model })
    .from(conversations)
    .where(eq(conversations.id, id))
    .limit(1);
  return row?.model ?? null;
}

describe("journey: sk-cli settings layering", () => {
  beforeAll(async () => {
    ctx = await createJourneyCtx("sk-cli-15-settings");
    userHome = mkdtempSync(join(tmpdir(), "sk-set-home-"));
    tmpWorkspace = mkdtempSync(join(tmpdir(), "sk-set-ws-"));
    prevSkHome = process.env.SK_HOME;
    process.env.SK_HOME = userHome;
  }, JOURNEY_HOOK_TIMEOUT);

  afterAll(async () => {
    if (prevSkHome !== undefined) process.env.SK_HOME = prevSkHome;
    else delete process.env.SK_HOME;
    rmSync(userHome, { recursive: true, force: true });
    rmSync(tmpWorkspace, { recursive: true, force: true });
    await ctx.cleanup();
  }, JOURNEY_HOOK_TIMEOUT);

  // Note: we deliberately only exercise project + local layers here
  // because loadSettings walks `homedir()` for the user layer, which
  // bun.test's SK_HOME override doesn't reroute (it reads HOME).
  // User-layer coverage is in the settings unit test.

  function writeProject(obj: unknown): void {
    mkdirSync(join(tmpWorkspace, ".sk"), { recursive: true });
    writeFileSync(join(tmpWorkspace, ".sk", "settings.json"), JSON.stringify(obj), "utf8");
  }

  function writeLocal(obj: unknown): void {
    mkdirSync(join(tmpWorkspace, ".sk"), { recursive: true });
    writeFileSync(join(tmpWorkspace, ".sk", "settings.local.json"), JSON.stringify(obj), "utf8");
  }

  function clearLayers(): void {
    // Remove everything written by previous tests so each test
    // starts from a known-clean state.
    try {
      rmSync(join(tmpWorkspace, ".sk"), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  test("AC1: project settings override defaults — loader observes it", () => {
    clearLayers();
    writeProject({ model: "project-model", defaultTenant: "project-tenant" });
    const r = loadSettings(tmpWorkspace);
    expect(r.merged.model).toBe("project-model");
    expect(r.merged.defaultTenant).toBe("project-tenant");
    expect(r.sources.some((s) => s.endsWith("settings.json"))).toBe(true);
  });

  test("AC2: local settings override project settings for the same key", () => {
    clearLayers();
    writeProject({ model: "from-project" });
    writeLocal({ model: "from-local" });
    const r = loadSettings(tmpWorkspace);
    expect(r.merged.model).toBe("from-local");
  });

  test("AC3: additionalDirectories — later layer replaces earlier array", () => {
    clearLayers();
    writeProject({ additionalDirectories: ["docs", "scripts"] });
    writeLocal({ additionalDirectories: ["local-only"] });
    const r = loadSettings(tmpWorkspace);
    expect(r.merged.additionalDirectories).toEqual(["local-only"]);
  });

  test("AC4: includeMemoryFile: false suppresses SUBKIT.md injection", async () => {
    clearLayers();
    writeFileSync(join(tmpWorkspace, "SUBKIT.md"), "# memory you shouldn't see", "utf8");
    writeProject({ includeMemoryFile: false });
    const result = await runHeadless({
      profile: profile(),
      prompt: "check memory suppression",
      output: "text",
      cwd: tmpWorkspace,
      stdout: makeBuf(),
      stderr: makeBuf(),
    });
    const id = result.conversation_id as string;
    // No memory on the conversation row.
    const [row] = await ctx.db
      .select({ memory: conversations.memory })
      .from(conversations)
      .where(eq(conversations.id, id))
      .limit(1);
    expect(row?.memory ?? null).toBeNull();
  });

  test("AC5: settings.model attaches to new conversations", async () => {
    clearLayers();
    writeProject({ model: "anthropic:claude-opus-4-6" });
    const result = await runHeadless({
      profile: profile(),
      prompt: "pick my model",
      output: "text",
      noMemory: true,
      cwd: tmpWorkspace,
      stdout: makeBuf(),
      stderr: makeBuf(),
    });
    const id = result.conversation_id as string;
    expect(await loadConversationModel(id)).toBe("anthropic:claude-opus-4-6");
  });

  test("AC6: missing files are tolerated", () => {
    clearLayers();
    const r = loadSettings(tmpWorkspace);
    // includeMemoryFile defaults to true; statusLine.showTokens true.
    expect(r.merged.includeMemoryFile).toBe(true);
    expect(r.merged.statusLine?.showTokens).toBe(true);
  });
});
