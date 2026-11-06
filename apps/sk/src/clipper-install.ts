import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import yauzl from "yauzl";
import { loadConfig } from "./config.ts";

const INSTALL_CONFIG_NAME = "install-config.json";
const MAX_ENTRIES = 256;
const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
const MAX_ENTRY_BYTES = 8 * 1024 * 1024;

interface ClipperArchiveManifest {
  sha256: string;
  files: string[];
}

interface InstallClipperOptions {
  archivePath: string;
  manifest: ClipperArchiveManifest;
  targetDir?: string;
  engineUrl?: string | null;
}

function stableInstallDir(): string {
  return path.join(homedir(), ".sk", "clipper");
}

function safeArchivePath(value: string): string | null {
  const normalized = value.replace(/\\/g, "/");
  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    normalized.includes("\0") ||
    normalized.split("/").some((part) => part === "" || part === "." || part === "..") ||
    /^[A-Za-z]:/.test(normalized)
  ) {
    return null;
  }
  return normalized;
}

function isSymlink(entry: yauzl.Entry): boolean {
  return (entry.externalFileAttributes >>> 16) >> 12 === 0o12;
}

async function readArchive(pathname: string, expectedSha: string): Promise<Buffer> {
  const archive = await fs.readFile(pathname);
  if (archive.byteLength > MAX_ARCHIVE_BYTES) {
    throw new Error("clipper archive exceeds the maximum size");
  }
  const actualSha = createHash("sha256").update(archive).digest("hex");
  if (actualSha !== expectedSha) {
    throw new Error("clipper archive checksum verification failed");
  }
  return archive;
}

async function extractArchive(
  archive: Buffer,
  destination: string,
  expectedFiles: string[],
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    yauzl.fromBuffer(
      archive,
      { lazyEntries: true, validateEntrySizes: true },
      (openError, zipfile) => {
        if (openError || !zipfile) {
          reject(openError ?? new Error("clipper archive could not be opened"));
          return;
        }
        const seen = new Set<string>();
        let entryCount = 0;
        let totalBytes = 0;
        let settled = false;
        const fail = (error: Error): void => {
          if (settled) return;
          settled = true;
          zipfile.close();
          reject(error);
        };
        zipfile.on("error", fail);
        zipfile.on("end", () => {
          if (settled) return;
          settled = true;
          const expected = new Set(expectedFiles);
          if (expected.size !== seen.size || [...expected].some((file) => !seen.has(file))) {
            reject(new Error("clipper archive does not match its manifest"));
            return;
          }
          resolve();
        });
        zipfile.on("entry", (entry: yauzl.Entry) => {
          entryCount += 1;
          if (entryCount > MAX_ENTRIES) {
            fail(new Error("clipper archive has too many entries"));
            return;
          }
          const relativePath = safeArchivePath(entry.fileName);
          if (!relativePath || entry.fileName.endsWith("/") || isSymlink(entry)) {
            fail(new Error("clipper archive contains an unsafe entry"));
            return;
          }
          if (seen.has(relativePath) || entry.uncompressedSize > MAX_ENTRY_BYTES) {
            fail(new Error("clipper archive contains an invalid entry"));
            return;
          }
          totalBytes += entry.uncompressedSize;
          if (totalBytes > MAX_ARCHIVE_BYTES) {
            fail(new Error("clipper archive expands beyond the maximum size"));
            return;
          }
          zipfile.openReadStream(entry, async (streamError, stream) => {
            if (streamError || !stream) {
              fail(streamError ?? new Error("clipper archive entry could not be read"));
              return;
            }
            const outputPath = path.join(destination, relativePath);
            try {
              await fs.mkdir(path.dirname(outputPath), { recursive: true });
              const chunks: Buffer[] = [];
              for await (const chunk of stream) chunks.push(Buffer.from(chunk));
              const contents = Buffer.concat(chunks);
              if (contents.byteLength !== entry.uncompressedSize) {
                fail(new Error("clipper archive entry size verification failed"));
                return;
              }
              await fs.writeFile(outputPath, contents, { mode: 0o644 });
              seen.add(relativePath);
              zipfile.readEntry();
            } catch (error) {
              fail(error instanceof Error ? error : new Error(String(error)));
            }
          });
        });
        zipfile.readEntry();
      },
    );
  });
}

async function writeFirstRunConfig(targetDir: string, engineUrl: string | null): Promise<void> {
  const configPath = path.join(targetDir, INSTALL_CONFIG_NAME);
  await fs.writeFile(configPath, `${JSON.stringify({ engine_url: engineUrl })}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

async function preserveInstallConfig(targetDir: string, stagedDir: string): Promise<boolean> {
  const existingPath = path.join(targetDir, INSTALL_CONFIG_NAME);
  try {
    await fs.copyFile(existingPath, path.join(stagedDir, INSTALL_CONFIG_NAME));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return false;
  }
}

async function replaceDirectory(stagedDir: string, targetDir: string): Promise<void> {
  const parent = path.dirname(targetDir);
  const backupDir = path.join(parent, `.clipper-backup-${process.pid}-${Date.now()}`);
  let movedCurrent = false;
  try {
    await fs.rename(targetDir, backupDir);
    movedCurrent = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    await fs.rename(stagedDir, targetDir);
  } catch (error) {
    if (movedCurrent) await fs.rename(backupDir, targetDir);
    throw error;
  }
  if (movedCurrent) await fs.rm(backupDir, { recursive: true, force: true });
}

function activeProfileEngineUrl(): string | null {
  const config = loadConfig();
  const value = config.profiles[config.active_profile]?.engine_url;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export async function installClipper(options: InstallClipperOptions): Promise<string> {
  if (!/^[0-9a-f]{64}$/.test(options.manifest.sha256)) {
    throw new Error("clipper archive manifest has an invalid checksum");
  }
  const targetDir = options.targetDir ?? stableInstallDir();
  const parent = path.dirname(targetDir);
  await fs.mkdir(parent, { recursive: true });
  const archive = await readArchive(options.archivePath, options.manifest.sha256);
  const stagedDir = await fs.mkdtemp(path.join(parent, ".clipper-stage-"));
  try {
    await extractArchive(archive, stagedDir, options.manifest.files);
    const hasExistingConfig = await preserveInstallConfig(targetDir, stagedDir);
    if (!hasExistingConfig) {
      await writeFirstRunConfig(stagedDir, options.engineUrl ?? activeProfileEngineUrl());
    }
    await replaceDirectory(stagedDir, targetDir);
    return targetDir;
  } catch (error) {
    await fs.rm(stagedDir, { recursive: true, force: true });
    throw error;
  }
}

export async function openChromeExtensions(): Promise<void> {
  const [bin, args]: [string, string[]] =
    process.platform === "darwin"
      ? ["open", ["-a", "Google Chrome", "chrome://extensions/"]]
      : process.platform === "win32"
        ? ["cmd.exe", ["/c", "start", "", "chrome://extensions/"]]
        : ["xdg-open", ["chrome://extensions/"]];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(bin, args, { detached: true, shell: false, stdio: "ignore" });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error("could not open Chrome"));
    });
  });
}

export const _internal = {
  extractArchive,
  safeArchivePath,
  stableInstallDir,
  preserveInstallConfig,
  writeFirstRunConfig,
};
