// Contract test for the zero-config local path.
//
// `scripts/start-local.ts` is the one command a newcomer runs, and it hard-codes
// three couplings: the Compose service it execs into, the starter workflow it
// runs, and the port it polls. Each of those lives somewhere else too. Nothing
// fails at review time when one side moves — it fails on a stranger's laptop,
// which is the worst place to find out.
//
// So this test holds the script against the things it depends on. It is a
// contract test, not a smoke test: it starts nothing and needs no Docker.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "bun:test";

import {
  BOOTSTRAP_LLM_PROVIDERS,
  BootstrapSetupPayloadSchema,
} from "../../apps/engine/src/onboarding/bootstrap.ts";
import { DEMO_WORKFLOWS } from "../../apps/engine/src/onboarding/demo-seed.ts";
import {
  LOCAL_DEFAULT_ADMIN_EMAIL,
  LOCAL_DEFAULT_LLM_API_KEY,
  LOCAL_DEFAULT_LLM_PROVIDER,
  LOCAL_DEFAULT_TENANT_NAME,
} from "../../apps/sk/src/commands/init.ts";
import { COMPOSE_SERVICE, DEFAULT_HOST_PORT, DEMO_WORKFLOW } from "../start-local.ts";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const compose = readFileSync(join(ROOT, "docker-compose.yml"), "utf8");
const initSource = readFileSync(join(ROOT, "apps/sk/src/commands/init.ts"), "utf8");
const startLocalSource = readFileSync(join(ROOT, "scripts/start-local.ts"), "utf8");

describe("start-local ↔ docker-compose.yml", () => {
  test("the service it execs into exists", () => {
    // Top-level service keys are indented by exactly two spaces.
    const services = [...compose.matchAll(/^ {2}([a-z0-9-]+):$/gm)].map((m) => m[1]);
    expect(services).toContain(COMPOSE_SERVICE);
  });

  test("the bootstrap key is passed through to the engine", () => {
    // A pass-through with no value: Compose forwards it only when set. Without
    // this line the engine mints its own random token and setup cannot be
    // scripted at all.
    expect(compose).toMatch(/^ {6}SUBKIT_BOOTSTRAP_KEY:\s*$/m);
  });

  test("the port it polls is the published default", () => {
    // `- "${BIND_ADDRESS:-127.0.0.1}:${SUBKIT_HOST_PORT:-3000}:3000"`
    const published = compose.match(/\$\{SUBKIT_HOST_PORT:-(\d+)\}/);
    expect(published?.[1]).toBe(DEFAULT_HOST_PORT);
  });
});

describe("start-local ↔ the seeded starter workflows", () => {
  test("the workflow it runs is one the tenant actually gets", () => {
    expect(DEMO_WORKFLOWS.map((w) => w.slug)).toContain(DEMO_WORKFLOW);
  });

  test("that workflow needs no credentials", () => {
    // The point of the starter workflow is a green execution on a machine with
    // no accounts. A step that references a connector would break that.
    const spec = DEMO_WORKFLOWS.find((w) => w.slug === DEMO_WORKFLOW);
    expect(spec).toBeDefined();
    expect(JSON.stringify(spec?.dag)).not.toContain("connector_id");
  });
});

describe("sk init --defaults ↔ the engine's setup contract", () => {
  test("the flag exists and fills every payload field", () => {
    expect(initSource).toContain("defaults:");
    for (const field of ["admin_email", "tenant_name", "llm_provider", "llm_api_key"]) {
      expect(initSource).toContain(`partial.${field} ??=`);
    }
  });

  test("the default provider is one the engine accepts", () => {
    expect(BOOTSTRAP_LLM_PROVIDERS as readonly string[]).toContain("mock");
  });

  test("the local defaults satisfy the engine's payload schema", () => {
    // Caught a real defect on 2026-09-02: the first fallback address was
    // `admin@localhost`, which the engine's email check rejects. On a machine
    // with no git config that turned `--defaults` into an HTTP 400 whose text
    // said nothing about git. The placeholder key is load-bearing too — the
    // engine requires a non-empty key for every provider, `mock` included.
    const parsed = BootstrapSetupPayloadSchema.safeParse({
      admin_email: LOCAL_DEFAULT_ADMIN_EMAIL,
      tenant_name: LOCAL_DEFAULT_TENANT_NAME,
      llm_provider: LOCAL_DEFAULT_LLM_PROVIDER,
      llm_api_key: LOCAL_DEFAULT_LLM_API_KEY,
    });
    expect(parsed.success).toBe(true);
  });

  test("an empty key would be rejected — the placeholder is load-bearing", () => {
    const parsed = BootstrapSetupPayloadSchema.safeParse({
      admin_email: LOCAL_DEFAULT_ADMIN_EMAIL,
      tenant_name: LOCAL_DEFAULT_TENANT_NAME,
      llm_provider: LOCAL_DEFAULT_LLM_PROVIDER,
      llm_api_key: "",
    });
    expect(parsed.success).toBe(false);
  });
});

describe("start-local drives the CLI that ships in the image", () => {
  test("setup is fully flagged instead of relying on --defaults", () => {
    // The `sk` inside the pinned engine image is at least one release behind
    // this tree. A script that leaned on a newly added flag would fall into the
    // interactive prompt there, which reads as a hang — the exact failure this
    // whole package removes.
    for (const flag of ["--admin-email", "--tenant-name", "--llm-provider", "--llm-api-key"]) {
      expect(startLocalSource).toContain(`"${flag}"`);
    }
    expect(startLocalSource).not.toContain('"--defaults"');
  });

  test("the bootstrap key never lands in .env", () => {
    // Bun loads .env into process.env for every test run in this repository. A
    // fixed key there makes the engine mint the same token twice and breaks the
    // re-mint test. Caught exactly that way on 2026-09-02.
    expect(startLocalSource).not.toContain("appendFileSync");
    expect(startLocalSource).toMatch(/env: \{ \.\.\.process\.env, SUBKIT_BOOTSTRAP_KEY/);
  });
});

describe("first-run bootstrap seeds the starter workflows", () => {
  test("setup calls the demo seed", () => {
    // Wiring it in is the whole reason a fresh tenant has anything to run.
    // The call sits in bootstrap.ts's single completion path.
    const bootstrap = readFileSync(join(ROOT, "apps/engine/src/onboarding/bootstrap.ts"), "utf8");
    expect(bootstrap).toContain("seedOnboardingDemo");
  });
});
