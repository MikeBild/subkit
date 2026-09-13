// Cross-persona E2E tests — verifies workflows created by an admin
// persona are accessible from other personas, and that data flows
// correctly between different sk CLI invocations using distinct API keys.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  boot,
  cli,
  type E2EEnv,
  expectSuccess,
  run,
  runJson,
  shutdown,
  writeTempFile,
} from "./setup.ts";

let env: E2EEnv;
beforeAll(async () => {
  env = await boot("cross-cli", { llm: "mock" });
}, 90_000);
afterAll(async () => {
  await shutdown(env);
}, 30_000);

// ---------------------------------------------------------------------------
// Scenario 1: Admin creates workflow via sk, user queries via sk
// ---------------------------------------------------------------------------
describe("admin create → member query", () => {
  test("workflow created by admin is visible to member via sk", async () => {
    // Step 1: Admin creates a workflow via sk CLI.
    //
    // `--skip-checks` bypasses the validate+preview pre-flight that
    // `workflows create` runs by default. Without it the CLI would
    // actually execute the workflow's `request` step against an
    // external host at create time — a third-party 503 then makes
    // create exit 1 without persisting, and the visibility assertion
    // below would fail with an unhelpful "workflow not found" rather
    // than a clear "external dependency flaked". This suite tests
    // cross-persona visibility, not external reachability.
    const wfDef = JSON.stringify({
      name: "cross-cli-test",
      slug: "cross-cli-test",
      description: "A workflow created by admin for member to query",
      steps: [
        { kind: "request", id: "fetch", method: "GET", url: `${env.baseUrl}/openapi.json` },
        {
          kind: "transform",
          id: "pluck",
          language: "javascript",
          expression: "return input.scope.fetch.data.info;",
        },
      ],
    });
    const filePath = writeTempFile(env.personas.admin, "cross-cli-wf.json", wfDef);
    const createResult = await cli(["workflows", "create", "--file", filePath, "--skip-checks"], {
      env,
      persona: "admin",
    });
    expectSuccess(createResult, "sk workflows create (admin)");

    // Step 2: Verify it exists via sk list as admin.
    const wfs = await runJson<Array<{ id: string; name: string }>>(["workflows", "list"], {
      env,
      persona: "admin",
    });
    const list = Array.isArray(wfs) ? wfs : [wfs];
    const wf = list.find((w) => w.name === "cross-cli-test");
    expect(wf).toBeTruthy();

    // Step 3: Member can also see it via sk.
    const memberList = await run(["workflows", "list"], { env, persona: "member" });
    expect(memberList).toContain("cross-cli-test");
    // Three sk-CLI spawns against a live engine — well past bun's 5s
    // default test timeout on a saturated CI runner (failures landed at
    // ~5003ms = the bun timeout SIGTERM-ing the CLI). Sized like the
    // sibling e2e tests in this file.
  }, 90_000);
});

// ---------------------------------------------------------------------------
// Scenario 2: sk conversation creates data, admin audit shows it
// ---------------------------------------------------------------------------
describe("sk converse → sk audit", () => {
  test("sk conversation appears in audit log", async () => {
    // Step 1: User starts a conversation via sk.
    const skResult = await cli(["--p", "list all available workflows", "--output", "json"], {
      env,
      persona: "member",
      timeout: 60_000,
    });
    expectSuccess(skResult, "sk converse");
    const data = JSON.parse(skResult.stdout) as { session_id: string };
    expect(data.session_id).toBeTruthy();

    // Step 2: Admin sees the conversation creation in the audit log.
    const auditOut = await run(["audit", "query", "--limit", "20"], {
      env,
      persona: "admin",
    });
    expect(auditOut).toContain("conversation.created");
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: Multiple personas interact, engine logs stay clean
// ---------------------------------------------------------------------------
describe("concurrent persona usage", () => {
  test("all three personas can use the system simultaneously", async () => {
    const results = await Promise.all([
      cli(["health"], { env, persona: "admin" }),
      cli(["health"], { env, persona: "member" }),
      cli(["health"], { env, persona: "enduser" }),
      cli(["--p", "hello from admin", "--output", "json"], {
        env,
        persona: "admin",
        timeout: 60_000,
      }),
      cli(["--p", "hello from member", "--output", "json"], {
        env,
        persona: "member",
        timeout: 60_000,
      }),
    ]);

    for (const r of results) {
      expectSuccess(r, "concurrent persona");
    }
  });
});
