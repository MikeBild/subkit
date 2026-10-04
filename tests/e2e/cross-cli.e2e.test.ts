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

describe("admin create → member query", () => {
  test("workflow created by admin is visible to member via sk", async () => {
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

    const wfs = await runJson<Array<{ id: string; name: string }>>(["workflows", "list"], {
      env,
      persona: "admin",
    });
    const list = Array.isArray(wfs) ? wfs : [wfs];
    const wf = list.find((w) => w.name === "cross-cli-test");
    expect(wf).toBeTruthy();

    const memberList = await run(["workflows", "list"], { env, persona: "member" });
    expect(memberList).toContain("cross-cli-test");
  }, 90_000);
});

describe("sk converse → sk audit", () => {
  test("sk conversation appears in audit log", async () => {
    const skResult = await cli(["--p", "list all available workflows", "--output", "json"], {
      env,
      persona: "member",
      timeout: 60_000,
    });
    expectSuccess(skResult, "sk converse");
    const data = JSON.parse(skResult.stdout) as { session_id: string };
    expect(data.session_id).toBeTruthy();

    const auditOut = await run(["audit", "query", "--limit", "20"], {
      env,
      persona: "admin",
    });
    expect(auditOut).toContain("conversation.created");
  });
});

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
