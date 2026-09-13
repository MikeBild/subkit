// Stateless replacement acceptance: product state must survive replacing the
// application container while no application volume or /data mount exists.

import { beforeAll, describe, expect, test } from "bun:test";

import {
  dockerApi,
  dockerBoot,
  type DockerEnv,
  engineMounts,
  replaceEngineContainer,
} from "./_harness.ts";

let env: DockerEnv;
beforeAll(async () => {
  env = await dockerBoot();
}, 600_000);

describe("stateless application replacement", () => {
  test("PostgreSQL settings and S3 bytes survive a container replacement", async () => {
    expect(engineMounts()).toEqual([]);

    const suffix = process.pid.toString(36);
    const workflow = await dockerApi<{ id: string }>(env, "POST", "/v1/workflows", {
      name: `Stateless replacement ${suffix}`,
      slug: `stateless-replacement-${suffix}`,
      steps: [
        {
          id: "echo",
          kind: "transform",
          language: "javascript",
          expression: "return { survived: true };",
        },
      ],
    });
    expect(workflow.status).toBe(201);

    const content = `object-store-survives-${suffix}`;
    const file = await dockerApi<{ id: string; sha256: string }>(env, "POST", "/v1/files/inline", {
      filename: `stateless-${suffix}.txt`,
      content_type: "text/plain",
      content_base64: Buffer.from(content, "utf8").toString("base64"),
    });
    expect(file.status).toBe(201);

    const runtimeBefore = await dockerApi<{
      saved_revision: number;
      active_revision: number;
    }>(env, "GET", "/v1/settings/runtime");
    expect(runtimeBefore.status).toBe(200);

    await replaceEngineContainer();
    expect(engineMounts()).toEqual([]);

    const workflowAfter = await dockerApi(env, "GET", `/v1/workflows/${workflow.body.id}`);
    expect(workflowAfter.status).toBe(200);
    const runtimeAfter = await dockerApi<{
      saved_revision: number;
      active_revision: number;
    }>(env, "GET", "/v1/settings/runtime");
    expect(runtimeAfter.status).toBe(200);
    expect(runtimeAfter.body).toMatchObject(runtimeBefore.body);

    const bytes = await fetch(`${env.baseUrl}/v1/files/${file.body.id}/content`, {
      headers: { Authorization: `Bearer ${env.adminKey}` },
    });
    expect(bytes.status).toBe(200);
    expect(await bytes.text()).toBe(content);
  }, 180_000);
});
