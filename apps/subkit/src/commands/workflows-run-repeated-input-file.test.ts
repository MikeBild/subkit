import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const NOW = "2026-01-01T00:00:00.000Z";
const workflowId = "7a773262-37a3-497c-bfb0-91309f558e21";
const uploadedFileIds = [
  "fid_aaaaaaaa-0000-0000-0000-000000000001",
  "fid_bbbbbbbb-0000-0000-0000-000000000002",
];

let directory: string;
let server: ReturnType<typeof Bun.serve>;
let uploadCount = 0;
let executionBodies: Record<string, unknown>[] = [];

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "subkit-repeated-input-file-"));
  writeFileSync(join(directory, "order.pdf"), "order");
  writeFileSync(join(directory, "receipt.pdf"), "receipt");
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/v1/files/inline") {
        const fileId = uploadedFileIds[uploadCount] ?? "fid_ffffffff-0000-0000-0000-000000000099";
        uploadCount += 1;
        return Response.json({
          id: fileId,
          status: "ready",
          filename: `file-${uploadCount}.pdf`,
          content_type: "application/pdf",
          size_bytes: 5,
          sha256: String(uploadCount),
          scan_result: null,
          created_at: NOW,
          updated_at: NOW,
          deleted_at: null,
        });
      }
      if (path === "/v1/executions") {
        executionBodies.push((await request.json()) as Record<string, unknown>);
        return Response.json({ execution_id: workflowId, status: "succeeded", output: {} });
      }
      return Response.json({ id: workflowId, name: "orders", slug: "orders" });
    },
  });
});

afterAll(async () => {
  await server.stop(true);
  rmSync(directory, { recursive: true, force: true });
});

test("workflows run keeps every repeated --input-file, wherever the options sit (#608)", async () => {
  uploadCount = 0;
  executionBodies = [];
  const args = [
    "run",
    workflowId,
    "--input-file",
    `order=${join(directory, "order.pdf")}`,
    "--input",
    '{"note":"keep"}',
    `--input-file=receipt=${join(directory, "receipt.pdf")}`,
  ];
  const commandPath = new URL("./workflows.ts", import.meta.url).pathname;
  const script = `import { runCommand } from "citty"; import { workflowsCommand } from ${JSON.stringify(commandPath)}; await runCommand(workflowsCommand, { rawArgs: ${JSON.stringify(args)} });`;
  const child = Bun.spawn([process.execPath, "-e", script], {
    env: {
      ...process.env,
      SUBKIT_ENGINE_URL: `http://127.0.0.1:${server.port}`,
      SUBKIT_API_KEY: "synthetic-cli-key",
      SUBKIT_TENANT: workflowId,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, errors] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect({ exitCode, errors: exitCode ? errors : "" }).toEqual({ exitCode: 0, errors: "" });
  expect(uploadCount).toBe(2);
  expect(executionBodies).toHaveLength(1);
  expect(executionBodies[0]?.input).toEqual({
    note: "keep",
    order: { $file: uploadedFileIds[0] },
    receipt: { $file: uploadedFileIds[1] },
  });
});
