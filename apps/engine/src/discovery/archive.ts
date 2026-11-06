import { walkZipEntries } from "../utils/zip-walk.ts";

interface ExtractedFile {
  filename: string;
  buffer: Buffer;
  mime?: string;
}

interface ArchiveExtractionResult {
  files: ExtractedFile[];
  skipped_count: number;
  skipped_reasons: Record<string, number>;
  total_bytes: number;
  truncated: boolean;
}

const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const MAX_PER_ENTRY_BYTES = 1 * 1024 * 1024;
const MAX_ENTRY_COUNT = 500;

const SKIP_PREFIXES = [
  "node_modules/",
  ".git/",
  "dist/",
  "build/",
  "out/",
  "target/",
  ".next/",
  ".venv/",
  "__pycache__/",
  ".cache/",
  ".turbo/",
  "coverage/",
];

const SKIP_EXACT = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
  "Cargo.lock",
  "poetry.lock",
  "Pipfile.lock",
  ".DS_Store",
]);

const SKIP_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".pdf",
  ".mp4",
  ".mov",
  ".mp3",
  ".wav",
  ".zip",
  ".tar",
  ".gz",
  ".tgz",
  ".jar",
  ".war",
  ".class",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".wasm",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".sqlite",
  ".db",
]);

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot).toLowerCase() : "";
}

function shouldSkip(path: string): string | null {
  for (const prefix of SKIP_PREFIXES) {
    if (path.startsWith(prefix) || path.includes(`/${prefix}`)) return "generated_dir";
  }
  const base = path.split("/").pop() ?? path;
  if (SKIP_EXACT.has(base)) return "lockfile_or_metadata";
  if (SKIP_EXTENSIONS.has(extensionOf(base))) return "binary_extension";
  return null;
}

export async function extractCodebaseArchive(buffer: Buffer): Promise<ArchiveExtractionResult> {
  const walked = await walkZipEntries(buffer, {
    maxEntries: MAX_ENTRY_COUNT,
    maxPerEntryBytes: MAX_PER_ENTRY_BYTES,
    maxTotalBytes: MAX_TOTAL_BYTES,
    shouldSkip,
  });
  return {
    files: walked.entries.map((e) => ({ filename: e.path, buffer: e.buffer })),
    skipped_count: walked.skipped_count,
    skipped_reasons: walked.skipped_reasons,
    total_bytes: walked.total_bytes,
    truncated: walked.truncated,
  };
}
