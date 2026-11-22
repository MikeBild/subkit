import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";

type ClipboardRead =
  | { kind: "none" }
  | { kind: "text"; text: string }
  | { kind: "image"; path: string; mediaType: string; bytes: number };

const DEFAULT_TIMEOUT_MS = 1500;

export function readClipboard(opts: { timeoutMs?: number } = {}): ClipboardRead {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const img = tryReadImage(timeoutMs);
  if (img.kind !== "none") return img;
  const txt = tryReadText(timeoutMs);
  if (txt.kind !== "none") return txt;
  return { kind: "none" };
}

function tryReadText(timeoutMs: number): ClipboardRead {
  switch (process.platform) {
    case "darwin":
      return runCapture(["pbpaste"], timeoutMs);
    case "linux":
      return (
        runCapture(["xclip", "-selection", "clipboard", "-o"], timeoutMs) ??
        runCapture(["wl-paste", "-n"], timeoutMs) ?? { kind: "none" }
      );
    case "win32":
      return runCapture(["powershell.exe", "-NoProfile", "-Command", "Get-Clipboard"], timeoutMs);
    default:
      return { kind: "none" };
  }
}

function runCapture(argv: string[], timeoutMs: number): ClipboardRead {
  const [cmd, ...args] = argv;
  if (!cmd) return { kind: "none" };
  try {
    const res = spawnSync(cmd, args, { timeout: timeoutMs, encoding: "utf8" });
    if (res.error || res.status !== 0) return { kind: "none" };
    const text = (res.stdout ?? "").replace(/\r\n/g, "\n");
    if (text.length === 0) return { kind: "none" };
    return { kind: "text", text };
  } catch {
    return { kind: "none" };
  }
}

function tryReadImage(timeoutMs: number): ClipboardRead {
  switch (process.platform) {
    case "darwin":
      return tryReadImageMacos(timeoutMs);
    case "linux":
      return tryReadImageLinux(timeoutMs);
    case "win32":
      return tryReadImageWindows(timeoutMs);
    default:
      return { kind: "none" };
  }
}

function tryReadImageMacos(timeoutMs: number): ClipboardRead {
  try {
    const res = spawnSync("pbpaste", ["-Prefer", "png"], {
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
    });
    if (res.error || res.status !== 0) return { kind: "none" };
    const buf = res.stdout;
    if (!buf || buf.length < 8) return { kind: "none" };
    if (!isPngHeader(buf)) return { kind: "none" };
    const path = writeTempImage(buf, ".png");
    return { kind: "image", path, mediaType: "image/png", bytes: buf.length };
  } catch {
    return { kind: "none" };
  }
}

function tryReadImageLinux(timeoutMs: number): ClipboardRead {
  try {
    const res = spawnSync("xclip", ["-selection", "clipboard", "-t", "image/png", "-o"], {
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
    });
    if (res.error || res.status !== 0) return { kind: "none" };
    const buf = res.stdout;
    if (!buf || buf.length < 8 || !isPngHeader(buf)) return { kind: "none" };
    const path = writeTempImage(buf, ".png");
    return { kind: "image", path, mediaType: "image/png", bytes: buf.length };
  } catch {
    return { kind: "none" };
  }
}

function tryReadImageWindows(timeoutMs: number): ClipboardRead {
  try {
    const tmpPath = join(
      mkdtempSync(join(tmpdir(), "subkit-clip-")),
      `clipboard-${Date.now()}.png`,
    );
    const script = `Add-Type -AssemblyName System.Windows.Forms;
      $img = [System.Windows.Forms.Clipboard]::GetImage();
      if ($img -ne $null) {
        $img.Save('${tmpPath.replace(/\\/g, "\\\\")}', [System.Drawing.Imaging.ImageFormat]::Png);
        Write-Output 'OK';
      }`;
    const res = spawnSync("powershell.exe", ["-NoProfile", "-Command", script], {
      timeout: timeoutMs,
      encoding: "utf8",
    });
    if (res.error || res.status !== 0) return { kind: "none" };
    if (!res.stdout?.includes("OK")) return { kind: "none" };
    try {
      const { statSync } = require("node:fs");
      const st = statSync(tmpPath);
      return { kind: "image", path: tmpPath, mediaType: "image/png", bytes: st.size };
    } catch {
      return { kind: "image", path: tmpPath, mediaType: "image/png", bytes: 0 };
    }
  } catch {
    return { kind: "none" };
  }
}

function isPngHeader(buf: Buffer): boolean {
  return (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  );
}

function writeTempImage(buf: Buffer, ext: string): string {
  const dir = mkdtempSync(join(tmpdir(), "subkit-clip-"));
  const path = join(dir, `clip-${Date.now()}${ext}`);
  writeFileSync(path, buf);
  return path;
}

export function classifyAttachment(path: string): { kind: "image" | "file"; mediaType: string } {
  const ext = extname(path).toLowerCase();
  const imageExt = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".heic"]);
  if (imageExt.has(ext)) {
    const mediaType =
      ext === ".png"
        ? "image/png"
        : ext === ".gif"
          ? "image/gif"
          : ext === ".webp"
            ? "image/webp"
            : ext === ".heic"
              ? "image/heic"
              : "image/jpeg";
    return { kind: "image", mediaType };
  }
  const mediaByExt: Record<string, string> = {
    ".pdf": "application/pdf",
    ".md": "text/markdown",
    ".markdown": "text/markdown",
    ".txt": "text/plain",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".doc": "application/msword",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".xls": "application/vnd.ms-excel",
    ".csv": "text/csv",
    ".json": "application/json",
    ".yaml": "application/yaml",
    ".yml": "application/yaml",
  };
  return { kind: "file", mediaType: mediaByExt[ext] ?? "application/octet-stream" };
}
