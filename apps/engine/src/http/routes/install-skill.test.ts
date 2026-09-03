// The build-or-adopt skill the engine hands out.
//
// Three promises, each of which would fail silently without a test: the
// served file is the repository's file; the references it names are pages
// this binary actually carries, fetched from the engine that served the
// script; and the installer is a script that aborts rather than half-installs.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { OpenAPIHono } from "@hono/zod-openapi";
import { ESSENTIAL_PATHS } from "@shared/llms-index.ts";
import type { AppEnv } from "../openapi.ts";
import { createApp } from "../server.ts";
import {
  _internal,
  registerInstallSkillRoute,
  SKILL_MD,
  SKILL_REFERENCES,
} from "./install-skill.ts";
import { registerLlmsTxtRoutes } from "./llms-txt.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../../..");
const onDisk = readFileSync(join(ROOT, "agent-skills/build-or-adopt/SKILL.md"), "utf8");

function app(): OpenAPIHono<AppEnv> {
  const a = new OpenAPIHono<AppEnv>();
  registerInstallSkillRoute(a);
  registerLlmsTxtRoutes(a);
  return a;
}

describe("the skill file", () => {
  test("is served byte for byte from the repository copy", async () => {
    expect(SKILL_MD).toBe(onDisk);
    const res = await app().request("http://127.0.0.1/install/skill/SKILL.md");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/markdown");
    expect(await res.text()).toBe(onDisk);
  });

  test("carries Agent Skills frontmatter with the name the installer uses", () => {
    expect(SKILL_MD.startsWith("---\nname: build-or-adopt\ndescription: ")).toBe(true);
  });

  test("asks the reviewer's question verbatim and refuses deferrals", () => {
    // The wording is the one that produced the 4 % / 96 % answer in Track 0.1;
    // softening it is the regression this pins.
    expect(SKILL_MD).toContain(
      "Which parts of what you are about to write are application logic, and which\n> are generic execution infrastructure that existing software could replace?\n> Give the proportion.",
    );
    expect(SKILL_MD).toContain('"for now"');
    expect(SKILL_MD).toContain("decision: build | adopt <name>");
  });

  test("names every reference it ships and nothing it does not", () => {
    for (const r of SKILL_REFERENCES) {
      expect(SKILL_MD).toContain(`references/${r.file}`);
    }
    const named = [...SKILL_MD.matchAll(/references\/([a-z-]+\.md)/g)].map((m) => m[1]);
    expect(new Set(named)).toEqual(new Set(SKILL_REFERENCES.map((r) => r.file)));
  });

  test("asks the second question after an adopt", () => {
    // Measured 2026-09-03: a builder adopted Temporal at stage 4 and left its
    // own 199-line file engine in the tree. The trigger fires before the next
    // component; this section is what fires after an adopt.
    expect(SKILL_MD).toContain("## After an adopt decision, ask once more");
    expect(SKILL_MD).toContain("Delete those, or record why each one stays.");
  });

  test("points at the do-not-use column, not only at sk", () => {
    expect(SKILL_MD).toContain('"Do not\nuse sk when" table is binding');
  });
});

describe("the references", () => {
  test("are exactly the pages this binary embeds, and each one is served", async () => {
    expect(SKILL_REFERENCES.map((r) => `docs/${r.servedPath}`)).toEqual([...ESSENTIAL_PATHS]);
    for (const r of SKILL_REFERENCES) {
      const res = await app().request(`http://127.0.0.1/llms/${r.servedPath}`);
      expect(res.status).toBe(200);
    }
  });
});

describe("the installer", () => {
  const script = _internal.buildScript("6.0.0", "https://engine.example.com");

  test("is a bash script that aborts on error", () => {
    expect(script.startsWith("#!/usr/bin/env bash\n")).toBe(true);
    expect(script).toContain("set -euo pipefail");
  });

  test("embeds the skill unexpanded and fetches references from the serving engine", () => {
    expect(script).toContain("<<'SK_SKILL_EOF'");
    expect(script).toContain(SKILL_MD);
    expect(SKILL_MD).not.toContain("SK_SKILL_EOF");
    for (const r of SKILL_REFERENCES) {
      expect(script).toContain(`"\${ENGINE_URL}/llms/${r.servedPath}"`);
    }
    expect(script).toContain('ENGINE_URL="https://engine.example.com"');
    expect(script).not.toContain("github.com");
  });

  test("installs to both user-level skill directories unless told otherwise", () => {
    // One quoted word, or bash reads `SKILL_DIRS="a" "b"` as an assignment
    // followed by a command named "b".
    expect(script).toContain(`SKILL_DIRS='"\${HOME}/.claude/skills" "\${HOME}/.agents/skills"'`);
    expect(script).toContain("SK_SKILL_DIR");
  });

  test("is served with the script content type and no caching", async () => {
    const res = await app().request("http://127.0.0.1/install/skill");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/x-shellscript");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toContain('ENGINE_URL="http://127.0.0.1"');
  });

  test("rejects a forged host rather than interpolating it", async () => {
    const res = await app().request("http://127.0.0.1/install/skill", {
      headers: { "x-forwarded-proto": "https", "x-forwarded-host": "evil.example;rm -rf /" },
    });
    const body = await res.text();
    expect(body).not.toContain("rm -rf /");
    expect(body).toContain('ENGINE_URL=""');
  });
});

describe("in the real route table", () => {
  // The unit tests above register the skill route by itself. In production the
  // binary route owns `/install/{asset}` and 404s unknown assets; registered
  // first, it swallowed `/install/skill` on 6.25.0 while every test was green.
  // This goes through createApp() so the order server.ts uses is what is tested.
  test("/install/skill is reached before /install/{asset} can 404 it", async () => {
    const app = createApp();
    const res = await app.request("http://127.0.0.1/install/skill");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/x-shellscript");
    const file = await app.request("http://127.0.0.1/install/skill/SKILL.md");
    expect(file.status).toBe(200);
  });
});
