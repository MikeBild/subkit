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

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BOOTSTRAP_LLM_PROVIDERS,
  BootstrapSetupPayloadSchema,
} from "../../apps/engine/src/onboarding/bootstrap.ts";
import { DEMO_WORKFLOWS } from "../../apps/engine/src/onboarding/demo-seed.ts";
import { COMPOSE_SERVICE, DEFAULT_HOST_PORT, DEMO_WORKFLOW } from "../start-local.ts";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const compose = readFileSync(join(ROOT, "docker-compose.yml"), "utf8");
const initSource = readFileSync(join(ROOT, "apps/sk/src/commands/init.ts"), "utf8");

describe("start-local ↔ docker-compose.yml", () => {
  test("the service it execs into exists", () => {
    // Top-level service keys are indented by exactly two spaces.
    const services = [...compose.matchAll(/^ {2}([a-z0-9-]+):$/gm)].map((m) => m[1]);
    expect(services).toContain(COMPOSE_SERVICE);
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

  test("the fallback admin email satisfies the payload schema", () => {
    // Caught a real defect on 2026-09-02: the first fallback was
    // `admin@localhost`, which the engine's email check rejects. On a machine
    // with no git config that turned `--defaults` into an HTTP 400 whose text
    // said nothing about git.
    const fallback = initSource.match(/gitConfigEmail\(\) \?\? "([^"]+)"/)?.[1];
    expect(fallback).toBeTruthy();
    const parsed = BootstrapSetupPayloadSchema.safeParse({
      admin_email: fallback,
      tenant_name: "Local",
      llm_provider: "mock",
      llm_api_key: "placeholder",
    });
    expect(parsed.success).toBe(true);
  });

  test("the placeholder key satisfies the payload schema", () => {
    // The engine requires a non-empty key for every provider, mock included.
    // That is why --defaults supplies a placeholder instead of an empty string;
    // if the contract ever loosens, this test should be the reason it changes.
    const placeholder = initSource.match(
      /partial\.llm_api_key \?\?=\s*[\s\S]{0,120}?"([^"]+)"/,
    )?.[1];
    expect(placeholder).toBeTruthy();
    const parsed = BootstrapSetupPayloadSchema.safeParse({
      admin_email: "admin@example.com",
      tenant_name: "Local",
      llm_provider: "mock",
      llm_api_key: placeholder,
    });
    expect(parsed.success).toBe(true);
  });

  test("an empty key would be rejected — the placeholder is load-bearing", () => {
    const parsed = BootstrapSetupPayloadSchema.safeParse({
      admin_email: "admin@example.com",
      tenant_name: "Local",
      llm_provider: "mock",
      llm_api_key: "",
    });
    expect(parsed.success).toBe(false);
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
