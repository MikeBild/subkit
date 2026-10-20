import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import sharp from "sharp";
import {
  createHttpTestServer,
  createSecondaryTenant,
  type HttpTestServer,
  type SecondaryTenant,
} from "./setup.ts";

const ROOT = resolve(import.meta.dir, "../../../../..");

let ctx: HttpTestServer;
let secondary: SecondaryTenant;
let profileHome: string;
let inputPath: string;
let logoPath: string;

beforeAll(async () => {
  ctx = await createHttpTestServer("tenant-branding-cli");
  secondary = await createSecondaryTenant(ctx, "tenant-branding-cli");
  profileHome = await mkdtemp(join(tmpdir(), "sk-branding-cli-"));
  inputPath = join(profileHome, "branding.json");
  logoPath = join(profileHome, "logo.png");
  const logo = await sharp({
    create: { width: 2, height: 2, channels: 4, background: "#2563eb" },
  })
    .png()
    .toBuffer();
  await writeFile(
    inputPath,
    JSON.stringify({
      revision: 0,
      display_name: "CLI Research",
      subtitle: "Managed through sk",
      palette: "teal",
      logos: {
        light: {
          operation: "replace",
          mime_type: "image/png",
          content_base64: logo.toString("base64"),
        },
        dark: { operation: "keep" },
      },
    }),
  );
});

afterAll(async () => {
  await Promise.all([ctx.cleanup(), rm(profileHome, { recursive: true, force: true })]);
});

async function sk(args: string[]) {
  const child = Bun.spawn([process.execPath, "apps/sk/src/index.ts", "branding", ...args], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOME: profileHome,
      USERPROFILE: profileHome,
      SK_HOME: profileHome,
      XDG_CONFIG_HOME: profileHome,
      NO_COLOR: "1",
      NO_UPDATE_CHECK: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

function args(apiKey: string) {
  return ["--engine-url", ctx.baseUrl, "--api-key", apiKey, "--json"];
}

function json(output: string): Record<string, unknown> {
  return JSON.parse(output) as Record<string, unknown>;
}

test("the source CLI completes branding get, update, logo, reset, and reports API failures", async () => {
  const initial = await sk(["get", ...args(ctx.apiKey)]);
  expect(initial).toMatchObject({ exitCode: 0, stderr: "" });
  expect(json(initial.stdout)).toMatchObject({ configured: false, revision: 0 });

  const updated = await sk(["update", inputPath, ...args(ctx.apiKey)]);
  expect(updated).toMatchObject({ exitCode: 0, stderr: "" });
  expect(json(updated.stdout)).toMatchObject({
    configured: true,
    revision: 1,
    display_name: "CLI Research",
    palette: "teal",
    logos: { light: true, dark: false },
  });

  const read = await sk(["get", ...args(ctx.apiKey)]);
  expect(read.exitCode).toBe(0);
  expect(json(read.stdout)).toMatchObject({ revision: 1, display_name: "CLI Research" });

  const logo = await sk([
    "logo",
    "dark",
    "--revision",
    "1",
    "--output",
    logoPath,
    ...args(ctx.apiKey),
  ]);
  expect(logo).toMatchObject({ exitCode: 0, stdout: "", stderr: "" });
  expect((await readFile(logoPath)).subarray(0, 8)).toEqual(
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  );

  const stale = await sk(["reset", "0", ...args(ctx.apiKey)]);
  expect(stale.exitCode).toBe(1);
  expect(json(stale.stdout)).toMatchObject({ code: "tenant_branding_conflict" });

  const denied = await sk(["update", inputPath, ...args(secondary.member.apiKey)]);
  expect(denied.exitCode).toBe(2);
  expect(json(denied.stdout)).toMatchObject({ code: "forbidden" });

  const reset = await sk(["reset", "1", ...args(ctx.apiKey)]);
  expect(reset).toMatchObject({ exitCode: 0, stderr: "" });
  expect(json(reset.stdout)).toMatchObject({ configured: false, revision: 2 });
});
