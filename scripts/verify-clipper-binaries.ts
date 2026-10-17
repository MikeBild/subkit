import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { localDatabaseUrl } from "./lib/local-database-url.ts";

const root = join(import.meta.dir, "..");
const temporary = await mkdtemp(join(tmpdir(), "subkit-clipper-binaries-"));
const manifest = await Bun.file(join(root, "assets/clipper/manifest.json")).json();
const databaseName = `test_clipper_binary_${process.pid}_${randomBytes(6).toString("hex")}`;
const adminUrl = localDatabaseUrl(process.env);
const databaseUrl = new URL(adminUrl);
const fixtureEngineUrl = "https://engine.example/fixture";
databaseUrl.pathname = `/${databaseName}`;
databaseUrl.searchParams.set("options", "-c search_path=subkit,pg_catalog,public");
const admin = new pg.Client({ connectionString: adminUrl });
let engine: ReturnType<typeof Bun.spawn> | undefined;
let createdDatabase = false;

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function install(): Promise<void> {
  const command = Bun.spawn(
    [
      join(root, "dist/sk"),
      "clipper",
      "install",
      "--dir",
      join(temporary, "extension"),
      "--no-open",
      "--engine-url",
      fixtureEngineUrl,
    ],
    {
      cwd: temporary,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exitCode, stderr] = await Promise.all([
    command.exited,
    new Response(command.stderr).text(),
  ]);
  assert.equal(exitCode, 0, stderr);
}

try {
  await install();
  const configPath = join(temporary, "extension/install-config.json");
  assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), {
    engine_url: fixtureEngineUrl,
  });
  for (const filename of manifest.files as string[]) {
    assert.ok((await readFile(join(temporary, "extension", filename))).byteLength > 0);
  }
  await writeFile(configPath, JSON.stringify({ engine_url: "https://engine.example/knowledge" }));
  await install();
  assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), {
    engine_url: "https://engine.example/knowledge",
  });

  await admin.connect();
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  createdDatabase = true;
  const port = await unusedPort();
  await writeFile(
    join(temporary, "subkit.config.json"),
    JSON.stringify({ operations: { update_check_enabled: false } }),
  );
  engine = Bun.spawn([join(root, "dist/engine")], {
    cwd: temporary,
    env: {
      PATH: process.env.PATH,
      NODE_ENV: "test",
      DATABASE_URL: databaseUrl.toString(),
      MASTER_KEY: randomBytes(32).toString("hex"),
      CONFIGURATION_DIRECTORY: temporary,
      ENGINE_LISTEN_HOST: "127.0.0.1",
      PORT: String(port),
    },
    stdout: Bun.file(join(temporary, "engine.log")),
    stderr: Bun.file(join(temporary, "engine-errors.log")),
  });
  let response: Response | undefined;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (engine.exitCode !== null) {
      const lines = (await readFile(join(temporary, "engine.log"), "utf8")).split("\n");
      const failures = lines.flatMap((line) => {
        try {
          const entry = JSON.parse(line);
          return entry.level === "error" || entry.level === "fatal"
            ? [{ action: entry.action, error: entry.error, message: entry.msg }]
            : [];
        } catch {
          return [];
        }
      });
      throw new Error(
        `Engine exited before serving the embedded archive: ${JSON.stringify(failures)}`,
      );
    }
    try {
      response = await fetch(`http://127.0.0.1:${port}/install/clipper.zip`, {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) break;
    } catch {}
    await Bun.sleep(200);
  }
  assert.ok(response?.ok, "Engine did not serve the embedded extension archive");
  const archive = Buffer.from(await response.arrayBuffer());
  assert.equal(createHash("sha256").update(archive).digest("hex"), manifest.sha256);
  assert.equal(response.headers.get("x-subkit-sha256"), manifest.sha256);
  assert.deepEqual(archive, await readFile(join(root, "assets/clipper/clipper.zip")));
  process.stdout.write(
    "Compiled sk installs and updates from a temporary directory; compiled engine serves the identical embedded archive.\n",
  );
} finally {
  if (engine && engine.exitCode === null) {
    engine.kill();
    await Promise.race([engine.exited, Bun.sleep(5000)]);
    if (engine.exitCode === null) {
      engine.kill("SIGKILL");
      await engine.exited;
    }
  }
  if (createdDatabase) await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
  await admin.end();
  await rm(temporary, { recursive: true, force: true });
}
