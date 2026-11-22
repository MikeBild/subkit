import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { app, crashReporter } from "electron";
import {
  appendCrash,
  CRASH_FILE,
  type CrashEntry,
  type CrashSource,
  crashEntry,
  type GoneDetails,
  isCrash,
  parseCrashes,
} from "../shared/crashes.ts";
import { type AppLog, appLog } from "./app-log.ts";
import { readJson, writeJsonAtomic } from "./store.ts";

export class CrashCapture {
  private crashes: CrashEntry[] = [];
  private dumps: string | null = null;
  private file: string | null = null;

  constructor(private readonly log: AppLog) {}

  start(folder: string): void {
    this.dumps = join(folder, "crashes");
    this.file = join(folder, CRASH_FILE);
    this.crashes = parseCrashes(readJson(this.file));
    try {
      app.setPath("crashDumps", this.dumps);
      crashReporter.start({ uploadToServer: false, compress: true });
      this.log.info("crash.reporter.started");
    } catch (error) {
      this.log.error("crash.reporter.failed", error);
    }
    app.on("render-process-gone", (_event, contents, details) =>
      this.gone("renderer", details, contents.getURL().split(/[?#]/)[0]),
    );
    app.on("child-process-gone", (_event, details) =>
      this.gone(details.type === "GPU" ? "gpu" : "child", details),
    );
  }

  recent(): readonly CrashEntry[] {
    return this.crashes;
  }

  minidumps(): number {
    const dumps = this.dumps;
    if (!dumps || !existsSync(dumps)) return 0;
    try {
      return readdirSync(dumps, { recursive: true }).filter((name) => String(name).endsWith(".dmp"))
        .length;
    } catch {
      return 0;
    }
  }

  private gone(source: CrashSource, details: GoneDetails, label?: string): void {
    const entry = crashEntry(source, details, new Date().toISOString(), label);
    const fields = { process: entry.process, reason: entry.reason, exit_code: entry.exitCode };
    if (!isCrash(details)) {
      this.log.info(`process.gone.${source}`, fields);
      return;
    }
    this.log.warn(`process.gone.${source}`, fields);
    this.crashes = appendCrash(this.crashes, entry);
    if (!this.file) return;
    try {
      writeJsonAtomic(this.file, this.crashes);
    } catch {}
  }
}

export const crashCapture = new CrashCapture(appLog);
