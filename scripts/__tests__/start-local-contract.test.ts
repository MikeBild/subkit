import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
    const services = [...compose.matchAll(/^ {2}([a-z0-9-]+):$/gm)].map((m) => m[1]);
    expect(services).toContain(COMPOSE_SERVICE);
  });

  test("the bootstrap key is passed through to the engine", () => {
    expect(compose).toMatch(/^ {6}SUBKIT_BOOTSTRAP_KEY:\s*$/m);
  });

  test("the port it polls is the published default", () => {
    const published = compose.match(/\$\{SUBKIT_HOST_PORT:-(\d+)\}/);
    expect(published?.[1]).toBe(DEFAULT_HOST_PORT);
  });
});

describe("start-local ↔ the seeded starter workflows", () => {
  test("the workflow it runs is one the tenant actually gets", () => {
    expect(DEMO_WORKFLOWS.map((w) => w.slug)).toContain(DEMO_WORKFLOW);
  });

  test("that workflow needs no credentials", () => {
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
    for (const flag of ["--admin-email", "--tenant-name", "--llm-provider", "--llm-api-key"]) {
      expect(startLocalSource).toContain(`"${flag}"`);
    }
    expect(startLocalSource).not.toContain('"--defaults"');
  });

  test("the bootstrap key never lands in .env", () => {
    expect(startLocalSource).not.toContain("appendFileSync");
    expect(startLocalSource).toMatch(/env: \{ \.\.\.process\.env, SUBKIT_BOOTSTRAP_KEY/);
  });
});

describe("first-run bootstrap seeds the starter workflows", () => {
  test("setup calls the demo seed", () => {
    const bootstrap = readFileSync(join(ROOT, "apps/engine/src/onboarding/bootstrap.ts"), "utf8");
    expect(bootstrap).toContain("seedOnboardingDemo");
  });
});
