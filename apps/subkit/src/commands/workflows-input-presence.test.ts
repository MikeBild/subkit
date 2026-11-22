import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let directory: string;
let server: ReturnType<typeof Bun.serve>;
let captures: Record<string, unknown>[] = [];
const workflowId = "7a773262-37a3-497c-bfb0-91309f558e21";

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "subkit-input-presence-"));
  writeFileSync(
    join(directory, "workflow.json"),
    JSON.stringify({
      name: "optional-object",
      slug: "optional-object",
      input_schema: { type: "object", properties: {} },
      steps: [{ kind: "transform", id: "echo", expression: "$input" }],
    }),
  );
  writeFileSync(
    join(directory, "step.json"),
    JSON.stringify({ kind: "transform", id: "echo", expression: "$input" }),
  );
  writeFileSync(join(directory, "null.json"), "null");
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/v1/executions") {
        captures.push((await request.json()) as Record<string, unknown>);
        return Response.json({ execution_id: workflowId, status: "succeeded", output: {} });
      }
      if (path.includes("validate")) return Response.json({ ok: true, errors: [], warnings: [] });
      return Response.json({ id: workflowId, name: "optional-object", slug: "optional-object" });
    },
  });
});
afterAll(async () => {
  await server.stop(true);
  rmSync(directory, { recursive: true, force: true });
});

for (const mode of ["saved", "draft", "step", "preview", "create"] as const) {
  for (const supplied of ["omitted", "null", ...(mode === "saved" ? ["file-null"] : [])]) {
    test(`actual ${mode} command preserves ${supplied} input on HTTP`, async () => {
      captures = [];
      const workflowPath = join(directory, "workflow.json");
      const args =
        mode === "saved"
          ? ["run", workflowId]
          : mode === "draft"
            ? ["run", "--draft", workflowPath]
            : mode === "step"
              ? ["run", "--step", join(directory, "step.json")]
              : mode === "preview"
                ? ["preview", workflowPath]
                : ["create", "--file", workflowPath, "--json"];
      if (supplied !== "omitted")
        args.push(
          "--input",
          supplied === "file-null" ? `@${join(directory, "null.json")}` : "null",
        );
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
      const [exitCode, output, errors] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect({ exitCode, errors: exitCode ? errors : "", output: exitCode ? output : "" }).toEqual({
        exitCode: 0,
        errors: "",
        output: "",
      });
      expect(captures).toHaveLength(1);
      const captured = captures[0];
      if (!captured) throw new Error("execution request was not captured");
      expect(Object.hasOwn(captured, "input")).toBe(supplied !== "omitted");
      if (supplied !== "omitted") expect(captured.input).toBeNull();
    });
  }
}
