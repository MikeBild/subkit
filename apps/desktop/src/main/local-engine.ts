import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  LAUNCH_SECRET_HEADER,
  LOCAL_PORT_ENV,
  LOCAL_WORKSPACE_PATHS,
} from "@shared/device/local-launch.ts";
import {
  type PostgresProgram,
  type PostgresTarget,
  programFile,
} from "../shared/local/postgres-bundle.ts";
import { restartPlan } from "../shared/local/restart-policy.ts";
import {
  type BackupReason,
  backupName,
  backupsToPrune,
  type DatabaseEndpoint,
  databaseUrl,
  dataFolderRefusal,
  type EngineBootFailure,
  engineEndedReason,
  INITIAL_SUPERVISOR_STATE,
  LOCAL_DATABASE,
  LOCAL_DATABASE_USER,
  type LocalLayout,
  laptopPostgresSettings,
  nextSupervisorState,
  parseEngineBootFailed,
  parseEngineReady,
  parseMountTable,
  type SupervisorEvent,
  type SupervisorState,
  socketDirectoryFor,
  upgradePlan,
} from "../shared/local/supervisor-model.ts";
import { appLog } from "./app-log.ts";
import { engineHostEnv, loginPath } from "./login-path.ts";

export interface LocalEngineOptions {
  postgresDir: string;
  target: PostgresTarget;
  engineCommand: string[];
  appVersion: string;
  layout: LocalLayout;
  databasePassword: string;
  masterKey: string;
  preferredPort: number | null;
  engineEnv?: Record<string, string>;
  resolvePath?: () => Promise<string>;
  onStatus?: (state: SupervisorState) => void;
  onPort?: (port: number, reassigned: boolean) => void;
  now?: () => number;
  readyTimeoutMs?: number;
}

export interface PowerState {
  on_battery: boolean;
  low_power_mode: boolean;
}

export interface LocalEngineSession {
  port: number;
  launchSecret: string;
}

interface StoredState {
  engine_version: string | null;
  port: number | null;
}

const STOP_GRACE_MS = 20_000;
const LAUNCH_SECRET_BYTES = 32;

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

export function checkDataFolder(path: string): string | null {
  const mounts =
    process.platform === "darwin"
      ? parseMountTable(spawnSync("/sbin/mount", { encoding: "utf8" }).stdout ?? "")
      : [];
  return dataFolderRefusal(path, { platform: process.platform, home: homedir(), mounts });
}

export class LocalEngine {
  private state: SupervisorState = INITIAL_SUPERVISOR_STATE;
  private database: ChildProcess | null = null;
  private engine: ChildProcess | null = null;
  private endpoint: DatabaseEndpoint | null = null;
  private socketFallback: string | null = null;
  private session: LocalEngineSession | null = null;
  private crashes: readonly number[] = [];
  private stopping = false;
  private engineStopping = false;
  private power: PowerState = { on_battery: false, low_power_mode: false };

  constructor(private readonly options: LocalEngineOptions) {}

  get status(): SupervisorState {
    return this.state;
  }

  private emit(event: SupervisorEvent): void {
    this.state = nextSupervisorState(this.state, event);
    if (event.type === "fail" || event.type === "crashed")
      appLog.warn("local.supervisor", {
        event: event.type,
        phase: this.state.phase,
        reason: this.state.reason,
      });
    else appLog.info("local.supervisor", { event: event.type, phase: this.state.phase });
    this.options.onStatus?.(this.state);
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private program(name: PostgresProgram): string {
    return join(this.options.postgresDir, programFile(this.options.target, name));
  }

  private toolEnv(): NodeJS.ProcessEnv {
    return {
      PATH: process.env.PATH ?? "",
      PGUSER: LOCAL_DATABASE_USER,
      PGPASSWORD: this.options.databasePassword,
      PGDATABASE: LOCAL_DATABASE,
      ...(this.endpoint?.kind === "tcp"
        ? { PGHOST: this.endpoint.host, PGPORT: String(this.endpoint.port) }
        : this.endpoint
          ? { PGHOST: this.endpoint.directory }
          : {}),
      LC_ALL: "C",
    };
  }

  private run(name: PostgresProgram, args: string[], input?: string): string {
    const result = spawnSync(this.program(name), args, {
      env: this.toolEnv(),
      encoding: "utf8",
      ...(input !== undefined ? { input } : {}),
    });
    if (result.status !== 0)
      throw new Error(`${name} failed: ${(result.stderr || result.stdout || "").trim()}`);
    return result.stdout;
  }

  private async readState(): Promise<StoredState> {
    try {
      const raw = JSON.parse(
        await readFile(this.options.layout.state, "utf8"),
      ) as Partial<StoredState>;
      return {
        engine_version: typeof raw.engine_version === "string" ? raw.engine_version : null,
        port: typeof raw.port === "number" ? raw.port : null,
      };
    } catch {
      return { engine_version: null, port: null };
    }
  }

  private async writeState(state: StoredState): Promise<void> {
    await writeFile(this.options.layout.state, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  }

  async prepare(): Promise<void> {
    const { layout } = this.options;
    const refusal = checkDataFolder(layout.root);
    if (refusal) throw new Error(refusal);
    for (const folder of [layout.root, layout.backups, layout.logs])
      await mkdir(folder, { recursive: true, mode: 0o700 });
    await chmod(layout.root, 0o700);
  }

  async initCluster(): Promise<boolean> {
    const { pgdata } = this.options.layout;
    if (existsSync(join(pgdata, "PG_VERSION"))) return false;
    const windows = this.options.target.startsWith("win32");
    const passwordFile = windows
      ? join(this.options.layout.root, ".initdb-password")
      : "/dev/stdin";
    if (windows) await writeFile(passwordFile, this.options.databasePassword, { mode: 0o600 });
    try {
      this.run(
        "initdb",
        [
          "-D",
          pgdata,
          "-U",
          LOCAL_DATABASE_USER,
          `--pwfile=${passwordFile}`,
          "-A",
          "scram-sha-256",
          "-E",
          "UTF8",
          "--locale=C",
          "--no-instructions",
        ],
        windows ? undefined : this.options.databasePassword,
      );
    } finally {
      if (windows) await rm(passwordFile, { force: true });
    }
    return true;
  }

  private async databaseEndpoint(): Promise<DatabaseEndpoint> {
    if (this.options.target.startsWith("win32"))
      return { kind: "tcp", host: "127.0.0.1", port: await freeLoopbackPort() };
    this.socketFallback ??= await mkdtemp(join(tmpdir(), "subkit-pg-"));
    await chmod(this.socketFallback, 0o700);
    return {
      kind: "socket",
      directory: socketDirectoryFor(this.options.layout.pgdata, this.socketFallback),
    };
  }

  private stopOrphanedDatabase(): void {
    const { pgdata } = this.options.layout;
    if (!existsSync(join(pgdata, "postmaster.pid"))) return;
    const status = spawnSync(this.program("pg_ctl"), ["status", "-D", pgdata], {
      env: this.toolEnv(),
    });
    if (status.status === 0)
      spawnSync(this.program("pg_ctl"), ["stop", "-D", pgdata, "-m", "fast", "-w", "-t", "30"], {
        env: this.toolEnv(),
      });
  }

  async startDatabase(): Promise<DatabaseEndpoint> {
    this.stopOrphanedDatabase();
    const endpoint = await this.databaseEndpoint();
    this.endpoint = endpoint;
    const log = await this.logStream("postgres.log");
    const child = spawn(
      this.program("postgres"),
      ["-D", this.options.layout.pgdata, ...laptopPostgresSettings(endpoint)],
      { env: this.toolEnv(), stdio: ["ignore", "pipe", "pipe"] },
    );
    child.stdout?.on("data", log);
    child.stderr?.on("data", log);
    this.database = child;
    appLog.info("local.database.start", { pid: child.pid, endpoint: endpoint.kind });
    child.once("exit", (code, signal) => {
      appLog[this.stopping ? "info" : "warn"]("local.database.exit", {
        exit_code: code,
        signal,
      });
      this.onExit("database", child);
    });
    const deadline = this.now() + (this.options.readyTimeoutMs ?? 30_000);
    while (this.now() < deadline) {
      if (child.exitCode !== null)
        throw new Error("PostgreSQL ended while starting; see postgres.log");
      if (spawnSync(this.program("pg_isready"), ["-q"], { env: this.toolEnv() }).status === 0) {
        appLog.info("local.database.ready");
        return endpoint;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("PostgreSQL did not accept connections in time");
  }

  private async logStream(name: string): Promise<(chunk: Buffer) => void> {
    const path = join(this.options.layout.logs, name);
    await writeFile(path, "", { flag: "a", mode: 0o600 });
    const { appendFileSync } = await import("node:fs");
    return (chunk: Buffer) => appendFileSync(path, chunk);
  }

  async startEngine(): Promise<LocalEngineSession> {
    const endpoint = this.endpoint;
    if (!endpoint) throw new Error("the database is not running");
    const stored = await this.readState();
    const [command, ...args] = this.options.engineCommand;
    if (!command) throw new Error("no engine command");
    const launchSecret = randomBytes(LAUNCH_SECRET_BYTES).toString("base64url");
    const preferred = stored.port ?? this.options.preferredPort;
    const log = await this.logStream("engine.log");
    const hostEnv = engineHostEnv(await (this.options.resolvePath ?? loginPath)());
    const child = spawn(command, args, {
      env: {
        ...hostEnv,
        HOME: homedir(),
        NODE_ENV: "production",
        SUBKIT_DEPLOYMENT_MODE: "local_workspace",
        ...(preferred ? { [LOCAL_PORT_ENV]: String(preferred) } : {}),
        DATABASE_URL: databaseUrl(endpoint, this.options.databasePassword),
        MASTER_KEY: this.options.masterKey,
        OBJECT_STORAGE_BACKEND: "filesystem",
        OBJECT_STORAGE_ROOT: this.options.layout.files,
        ...this.options.engineEnv,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.engine = child;
    appLog.info("local.engine.start", { pid: child.pid, preferred_port: preferred });
    child.stderr?.on("data", log);
    child.once("exit", (code, signal) => {
      appLog[this.stopping || this.engineStopping ? "info" : "warn"]("local.engine.exit", {
        exit_code: code,
        signal,
      });
      this.onExit("engine", child);
    });
    let bootFailure: EngineBootFailure | null = null;
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("the engine did not report its port in time")),
        this.options.readyTimeoutMs ?? 120_000,
      );
      child.once("close", (code) => {
        clearTimeout(timer);
        reject(new Error(engineEndedReason(code, bootFailure)));
      });
      const lines = createInterface({ input: child.stdout as NodeJS.ReadableStream });
      lines.on("line", (line) => {
        log(Buffer.from(`${line}\n`));
        const failed = parseEngineBootFailed(line);
        if (failed) {
          bootFailure = failed;
          appLog.warn("local.engine.boot_failed", {
            phase: failed.phase,
            error: failed.error,
            next: failed.next,
          });
        }
        const ready = parseEngineReady(line);
        if (!ready) return;
        clearTimeout(timer);
        this.options.onPort?.(ready.port, ready.reassigned);
        child.stdin?.write(`${JSON.stringify({ launch_secret: launchSecret })}\n`);
        resolve(ready.port);
      });
    });
    await this.waitForHealth(port);
    appLog.info("local.engine.ready", { port });
    await this.writeState({ engine_version: this.options.appVersion, port });
    this.session = { port, launchSecret };
    await this.sendPower();
    return this.session;
  }

  private async waitForHealth(port: number): Promise<void> {
    const deadline = this.now() + (this.options.readyTimeoutMs ?? 120_000);
    while (this.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`, {
          headers: { host: `127.0.0.1:${port}` },
          signal: AbortSignal.timeout(2000),
        });
        if (response.ok) return;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error("the engine did not become healthy in time");
  }

  async start(): Promise<LocalEngineSession> {
    this.stopping = false;
    this.emit({ type: "start" });
    try {
      await this.prepare();
      const stored = await this.readState();
      const fresh = await this.initCluster();
      const plan = fresh
        ? "first_run"
        : upgradePlan(stored.engine_version, this.options.appVersion);
      this.emit({ type: "prepared", plan });
      if (this.state.phase === "failed") throw new Error(this.state.reason ?? "refused");
      await this.startDatabase();
      this.emit({ type: "database_ready" });
      if (this.state.phase === "backing_up") {
        await this.backup("update");
        this.emit({ type: "backup_done" });
      }
      const session = await this.startEngine();
      this.emit({ type: "engine_ready", port: session.port });
      return session;
    } catch (error) {
      this.emit({ type: "fail", reason: error instanceof Error ? error.message : String(error) });
      await this.stopProcesses();
      throw error;
    }
  }

  private onExit(process: "database" | "engine", child: ChildProcess): void {
    if (this.stopping || (process === "engine" && this.engineStopping)) return;
    if ((process === "engine" ? this.engine : this.database) !== child) return;
    if (this.state.phase !== "running") return;
    const plan = restartPlan(this.crashes, this.now());
    this.emit({ type: "crashed", process, plan });
    if (plan === null) {
      void this.stopProcesses();
      return;
    }
    this.crashes = plan.crashes;
    setTimeout(() => {
      void (async () => {
        await this.stopProcesses();
        this.stopping = false;
        this.emit({ type: "retry" });
        try {
          await this.startDatabase();
          this.emit({ type: "database_ready" });
          const session = await this.startEngine();
          this.emit({ type: "engine_ready", port: session.port });
        } catch (error) {
          this.emit({
            type: "fail",
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      })();
    }, plan.delay_ms);
  }

  async stopEngine(): Promise<void> {
    this.engineStopping = true;
    try {
      const engine = this.engine;
      if (engine && engine.exitCode === null) {
        engine.stdin?.end();
        engine.kill("SIGTERM");
        if (!(await waitForExit(engine, STOP_GRACE_MS))) engine.kill("SIGKILL");
      }
      this.engine = null;
      this.session = null;
    } finally {
      this.engineStopping = false;
    }
  }

  private async stopProcesses(): Promise<void> {
    this.stopping = true;
    await this.stopEngine();
    const database = this.database;
    if (database && database.exitCode === null) {
      database.kill("SIGINT");
      if (!(await waitForExit(database, STOP_GRACE_MS))) {
        database.kill("SIGQUIT");
        await waitForExit(database, 5000);
      }
    }
    this.database = null;
    this.endpoint = null;
  }

  async stop(): Promise<void> {
    this.emit({ type: "stop" });
    await this.stopProcesses();
    if (this.socketFallback) await rm(this.socketFallback, { recursive: true, force: true });
    this.socketFallback = null;
    this.emit({ type: "stopped" });
  }

  async backup(reason: BackupReason): Promise<string> {
    if (!this.endpoint || !this.database) throw new Error("the database is not running");
    const name = backupName(new Date(this.now()), reason);
    const folder = join(this.options.layout.backups, name);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    this.run("pg_dump", ["-Fc", "--no-owner", "-f", join(folder, "database.dump")]);
    if (existsSync(this.options.layout.files))
      await cp(this.options.layout.files, join(folder, "files"), { recursive: true });
    await writeFile(
      join(folder, "backup.json"),
      `${JSON.stringify({ app_version: this.options.appVersion, reason, created_at: new Date(this.now()).toISOString() })}\n`,
      { mode: 0o600 },
    );
    const existing = await readdir(this.options.layout.backups);
    for (const stale of backupsToPrune(existing))
      await rm(join(this.options.layout.backups, stale), { recursive: true, force: true });
    return name;
  }

  async restore(name: string): Promise<LocalEngineSession | null> {
    if (!/^[0-9TZ-]+-(update|manual|restore)$/.test(name)) throw new Error("unknown backup");
    if (!this.endpoint || !this.database) throw new Error("the database is not running");
    const folder = join(this.options.layout.backups, name);
    if (!existsSync(join(folder, "database.dump"))) throw new Error("unknown backup");
    const engineWasRunning = this.engine !== null;
    if (engineWasRunning) await this.stopEngine();
    await this.backup("restore");
    this.run("pg_restore", [
      "--clean",
      "--if-exists",
      "--create",
      "--no-owner",
      "-d",
      "template1",
      join(folder, "database.dump"),
    ]);
    if (existsSync(join(folder, "files"))) {
      await rm(this.options.layout.files, { recursive: true, force: true });
      await cp(join(folder, "files"), this.options.layout.files, { recursive: true });
    }
    return engineWasRunning ? await this.startEngine() : null;
  }

  async listBackups(): Promise<string[]> {
    if (!existsSync(this.options.layout.backups)) return [];
    return (await readdir(this.options.layout.backups)).sort().reverse();
  }

  async reportPower(power: PowerState): Promise<void> {
    this.power = power;
    await this.sendPower();
  }

  private async sendPower(): Promise<void> {
    const session = this.session;
    if (!session) return;
    const response = await fetch(`http://127.0.0.1:${session.port}${LOCAL_WORKSPACE_PATHS.power}`, {
      method: "PUT",
      headers: {
        host: `127.0.0.1:${session.port}`,
        "content-type": "application/json",
        [LAUNCH_SECRET_HEADER]: session.launchSecret,
      },
      body: JSON.stringify(this.power),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`the engine refused the power state (${response.status})`);
  }

  databaseEndpointInUse(): DatabaseEndpoint | null {
    return this.endpoint;
  }

  currentSession(): LocalEngineSession | null {
    return this.session;
  }
}
