import { spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { access, constants, mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type BrowserWindow, dialog, powerMonitor, type Session, shell } from "electron";
import type { LocalBusy, LocalFinishInput, LocalMoved, LocalView } from "../shared/ipc.ts";
import type { LocalSignIn } from "../shared/local/local-profile.ts";
import {
  type AiAccessInput,
  backupRows,
  classifyLocalFailure,
  type LocalErrorKind,
  type LocalProgress,
  localRuntime,
  NO_PROGRESS,
  type PowerReport,
  parseLowPowerMode,
  powerChanged,
  progressAfter,
} from "../shared/local/local-workspace-model.ts";
import {
  type DataFolderRefusal,
  type LocalLayout,
  localLayout,
} from "../shared/local/supervisor-model.ts";
import { checkDataFolder, LocalEngine, type LocalEngineSession } from "./local-engine.ts";
import { LocalLauncher } from "./local-workspace-launcher.ts";
import { readJson, writeJsonAtomic } from "./store.ts";
import type { SecretVault } from "./vault.ts";

const WORKSPACE = "default";
const VAULT_ENTRIES = ["local-engine:database-password", "local-engine:master-key"] as const;

interface LocalConfig {
  folder: string | null;
  deviceId: string;
  configured: boolean;
  aiConfigured: boolean;
  modelServer: string | null;
  origin: string | null;
  moved: LocalMoved | null;
}

export interface LocalWorkspaceHost {
  userData: string;
  vault: SecretVault;
  appVersion: string;
  packaged: boolean;
  resourcesPath: string;
  repo: string;
  deviceLabel: () => string;
  sessionFor: (origin: string) => Session;
  window: () => BrowserWindow | null;
  onChange: () => void;
  onSignedIn: (signedIn: LocalSignIn, setup: boolean) => void;
  onGone: (origin: string | null) => void;
  onSecret: (secret: string) => void;
  onError: (scope: string, error: unknown) => void;
}

function parseConfig(raw: unknown): LocalConfig {
  const item = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const text = (value: unknown) => (typeof value === "string" && value ? value : null);
  const moved = item.moved && typeof item.moved === "object" ? (item.moved as LocalMoved) : null;
  return {
    folder: text(item.folder),
    deviceId: text(item.deviceId) ?? randomUUID(),
    configured: item.configured === true,
    aiConfigured: item.aiConfigured !== false,
    modelServer: text(item.modelServer),
    origin: text(item.origin),
    moved: moved && text(moved.server) && text(moved.bundle) ? moved : null,
  };
}

function folderSize(path: string): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn("/usr/bin/du", ["-sk", path], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.once("error", () => resolve(null));
    child.once("exit", (code) => {
      const kb = Number.parseInt(out, 10);
      resolve(code === 0 && Number.isFinite(kb) ? kb * 1024 : null);
    });
  });
}

export class LocalWorkspaceController {
  private readonly configPath: string;
  private config: LocalConfig;
  private engine: LocalEngine | null = null;
  private starting: Promise<LocalEngineSession> | null = null;
  private launcher: LocalLauncher | null = null;
  private progress: LocalProgress = NO_PROGRESS;
  private working = false;
  private error: LocalErrorKind | null = null;
  private refusal: DataFolderRefusal | null = null;
  private busy: LocalBusy | null = null;
  private backups: LocalView["backups"] = [];
  private size: number | null = null;
  private power: PowerReport | null = null;
  private modelTools: boolean | null = null;
  private recovering = false;
  private pending: LocalSignIn | null = null;

  constructor(private readonly host: LocalWorkspaceHost) {
    this.configPath = join(host.userData, "local-workspace.json");
    this.config = parseConfig(readJson(this.configPath));
  }

  private runtime() {
    return localRuntime({
      packaged: this.host.packaged,
      platform: process.platform,
      arch: process.arch,
      resourcesPath: this.host.resourcesPath,
      repo: this.host.repo,
      exists: existsSync,
    });
  }

  get origin(): string | null {
    return this.config.origin;
  }

  get running(): boolean {
    return this.engine !== null;
  }

  get ready(): boolean {
    return this.launcher !== null && this.progress.workspace;
  }

  private folder(): string {
    return this.config.folder ?? this.host.userData;
  }

  private layout(): LocalLayout {
    return localLayout(this.folder(), WORKSPACE);
  }

  view(activeIsLocal: boolean): LocalView {
    const { configured, moved } = this.config;
    return {
      available: this.runtime() !== null,
      configured,
      attention: configured && !moved && activeIsLocal && !this.ready,
      folder: this.folder(),
      folderRefusal: this.refusal,
      progress: this.progress,
      working: this.working,
      error: this.error,
      backups: this.backups,
      sizeBytes: this.size,
      busy: this.busy,
      moved,
      aiConfigured: this.config.aiConfigured,
      modelTools: this.modelTools,
    };
  }

  start(): void {
    const report = () => void this.reportPower(false);
    powerMonitor.on("on-battery", report);
    powerMonitor.on("on-ac", report);
    powerMonitor.on("speed-limit-change", report);
    powerMonitor.on("resume", () => void this.reportPower(true));
    if (this.config.configured) void this.begin();
  }

  private save(): void {
    writeJsonAtomic(this.configPath, this.config);
  }

  private changed(): void {
    this.host.onChange();
  }

  private fail(scope: string, error: unknown, kind?: LocalErrorKind): void {
    this.host.onError(scope, error);
    this.error =
      kind ?? classifyLocalFailure(error instanceof Error ? error.message : String(error));
    this.working = false;
    this.changed();
  }

  private secret(name: (typeof VAULT_ENTRIES)[number], create: () => string): string {
    const value = this.host.vault.get(name) ?? create();
    if (this.host.vault.get(name) !== value) this.host.vault.set(name, value);
    this.host.onSecret(value);
    return value;
  }

  private adopt(session: LocalEngineSession): LocalLauncher {
    this.host.onSecret(session.launchSecret);
    this.launcher = new LocalLauncher(session, this.host.sessionFor);
    return this.launcher;
  }

  async pickFolder(): Promise<void> {
    if (this.working || this.config.configured) return;
    if (this.engine) await this.cancel();
    const parent = this.host.window();
    const options = { properties: ["openDirectory" as const, "createDirectory" as const] };
    const picked = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options);
    const path = picked.filePaths[0];
    if (picked.canceled || !path) return;
    this.config = { ...this.config, folder: path };
    this.refusal = checkDataFolder(path) as DataFolderRefusal | null;
    this.error = null;
    this.changed();
  }

  begin(): Promise<LocalEngineSession> | null {
    if (this.starting) return this.starting;
    const runtime = this.runtime();
    if (!runtime || this.config.moved) return null;
    this.error = null;
    this.working = true;
    this.changed();
    this.starting = this.startEngine(runtime).catch((error) => {
      this.starting = null;
      this.fail("local.start", error);
      throw error;
    });
    this.starting.catch(() => {});
    return this.starting;
  }

  private async startEngine(
    runtime: NonNullable<ReturnType<LocalWorkspaceController["runtime"]>>,
  ): Promise<LocalEngineSession> {
    const refusal = checkDataFolder(this.folder());
    if (refusal) throw new Error(refusal);
    await mkdir(this.folder(), { recursive: true });
    await access(this.folder(), constants.W_OK);
    const layout = this.layout();
    this.engine ??= new LocalEngine({
      postgresDir: runtime.postgresDir,
      target: "darwin-arm64",
      engineCommand: runtime.engineCommand,
      appVersion: this.host.appVersion,
      layout,
      databasePassword: this.secret("local-engine:database-password", () =>
        randomBytes(24).toString("base64url"),
      ),
      masterKey: this.secret("local-engine:master-key", () => randomBytes(32).toString("hex")),
      preferredPort: null,
      onStatus: (state) => {
        this.progress = progressAfter(this.progress, state.phase);
        if (state.phase === "failed" && state.reason)
          this.fail("local.engine", new Error(state.reason));
        if (state.phase === "restarting") {
          this.launcher = null;
          this.recovering = true;
        }
        if (state.phase === "running" && this.recovering) void this.recover();
        this.changed();
      },
    });
    const session = await this.engine.start();
    this.adopt(session);
    spawn("/usr/bin/tmutil", ["addexclusion", layout.pgdata], { stdio: "ignore" }).on(
      "error",
      () => {},
    );
    await this.reportPower(true);
    if (this.config.configured) this.handOver(await this.signIn(null), false);
    this.working = false;
    void this.refresh();
    this.changed();
    return session;
  }

  private async recover(): Promise<void> {
    this.recovering = false;
    const session = this.engine?.currentSession() ?? null;
    if (!session) return;
    this.adopt(session);
    try {
      await this.reportPower(true);
      if (this.config.configured) this.handOver(await this.signIn(null), false);
    } catch (error) {
      this.fail("local.recover", error);
    }
  }

  private handOver(signedIn: LocalSignIn, setup: boolean): void {
    this.progress = { ...this.progress, workspace: true };
    this.host.onSignedIn(signedIn, setup);
    this.changed();
  }

  private async signIn(name: string | null): Promise<LocalSignIn> {
    const launcher = this.launcher;
    if (!launcher) throw new Error("the local engine is not running");
    const signed = await launcher.signIn({
      deviceId: this.config.deviceId,
      deviceLabel: this.host.deviceLabel(),
      name,
    });
    if (this.config.modelServer)
      await this.storeAi({ kind: "model", origin: this.config.modelServer });
    const previousOrigin = this.config.origin !== signed.origin ? this.config.origin : null;
    this.config = { ...this.config, origin: signed.origin };
    this.save();
    return { ...signed, previousOrigin };
  }

  private async storeAi(ai: AiAccessInput): Promise<boolean> {
    const launcher = this.launcher;
    if (!launcher) return false;
    if (ai.kind === "provider") this.host.onSecret(ai.key);
    const stored = await launcher.storeAi(ai);
    if (stored.accepted) this.modelTools = ai.kind === "model" ? stored.tools : null;
    return stored.accepted;
  }

  async finish(input: LocalFinishInput): Promise<void> {
    this.error = null;
    this.working = true;
    this.changed();
    try {
      const starting = this.begin();
      if (!starting) throw new Error("local mode is not available");
      await starting;
      this.pending ??= await this.signIn(input.name);
      if (input.ai && !(await this.storeAi(input.ai))) {
        this.error = "keyRejected";
        this.working = false;
        this.changed();
        return;
      }
      this.config = {
        ...this.config,
        configured: true,
        aiConfigured: input.ai !== null,
        modelServer: input.ai?.kind === "model" ? input.ai.origin : null,
      };
      this.save();
      this.handOver(this.pending, true);
      this.pending = null;
      this.working = false;
      this.changed();
    } catch (error) {
      this.fail("local.finish", error);
    }
  }

  async cancel(): Promise<void> {
    if (this.config.configured) return;
    await this.stop();
    this.pending = null;
    this.progress = NO_PROGRESS;
    this.error = null;
    this.working = false;
    this.changed();
  }

  async stop(): Promise<void> {
    const engine = this.engine;
    this.engine = null;
    this.starting = null;
    this.launcher = null;
    if (engine) await engine.stop().catch((error) => this.host.onError("local.stop", error));
  }

  async activeRuns(): Promise<number> {
    return (await this.launcher?.activeRuns().catch(() => 0)) ?? 0;
  }

  private async operate(busy: LocalBusy, failure: LocalErrorKind, work: () => Promise<void>) {
    if (this.busy) return;
    this.busy = busy;
    this.error = null;
    this.changed();
    try {
      await work();
    } catch (error) {
      this.host.onError(`local.${busy}`, error);
      this.error = failure;
    } finally {
      this.busy = null;
      await this.refresh();
      this.changed();
    }
  }

  private async paused(work: () => Promise<void>): Promise<void> {
    const launcher = this.launcher;
    await launcher?.workers(true);
    try {
      await work();
    } finally {
      if (this.launcher === launcher) await launcher?.workers(false);
    }
  }

  backup(): Promise<void> {
    return this.operate("backup", "failed", () =>
      this.paused(async () => {
        await this.engine?.backup("manual");
      }),
    );
  }

  restore(name: string): Promise<void> {
    return this.operate("restore", "restore", () =>
      this.paused(async () => {
        const session = await this.engine?.restore(name);
        if (!session) return;
        this.adopt(session);
        this.handOver(await this.signIn(null), false);
      }),
    );
  }

  move(serverOrigin: string): Promise<void> {
    return this.operate("move", "move", async () => {
      const launcher = this.launcher;
      if (!launcher || this.config.moved) throw new Error("the local engine is not running");
      const bundle = await launcher.exportForMove(serverOrigin);
      const folder = join(this.layout().root, "exports");
      await mkdir(folder, { recursive: true, mode: 0o700 });
      const path = join(folder, bundle.name);
      await writeFile(path, bundle.bytes, { mode: 0o600 });
      await this.stop();
      this.progress = NO_PROGRESS;
      this.config = { ...this.config, moved: { server: serverOrigin, bundle: path } };
      this.save();
      this.host.onGone(this.config.origin);
    });
  }

  removeAll(): Promise<void> {
    return this.operate("remove", "failed", async () => {
      await this.stop();
      const data = dirname(this.layout().root);
      if (existsSync(data)) await shell.trashItem(data);
      for (const name of VAULT_ENTRIES) this.host.vault.set(name, null);
      const origin = this.config.origin;
      rmSync(this.configPath, { force: true });
      this.config = parseConfig(null);
      this.progress = NO_PROGRESS;
      this.backups = [];
      this.size = null;
      this.modelTools = null;
      this.host.onGone(origin);
    });
  }

  async refresh(): Promise<void> {
    const layout = this.layout();
    if (!existsSync(layout.backups)) return;
    const names = await readdir(layout.backups).catch(() => [] as string[]);
    const sized = await Promise.all(
      names.map(async (name) => ({
        name,
        sizeBytes: await folderSize(join(layout.backups, name)),
      })),
    );
    this.backups = backupRows(sized);
    this.size = await folderSize(layout.root);
  }

  private async reportPower(force: boolean): Promise<void> {
    const engine = this.engine;
    if (!engine || !this.launcher) return;
    const pmset = spawnSync("/usr/bin/pmset", ["-g"], { encoding: "utf8" });
    const next: PowerReport = {
      on_battery: powerMonitor.isOnBatteryPower(),
      low_power_mode: parseLowPowerMode(pmset.stdout ?? ""),
    };
    if (!force && !powerChanged(this.power, next)) return;
    this.power = next;
    await engine.reportPower(next).catch((error) => this.host.onError("local.power", error));
  }
}
