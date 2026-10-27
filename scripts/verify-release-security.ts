import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");
const REQUIRED_RUNTIME_FILES = [
  "BASE_IMAGE_INVENTORY.txt",
  "LICENSE",
  "SOURCE_OFFER.txt",
  "THIRD_PARTY_NOTICES.txt",
] as const;

export interface ReleaseSecurityArgs {
  image: string;
  outputDir: string;
  assetsDir?: string;
}

interface TrivyFinding {
  kind: "misconfiguration" | "secret" | "vulnerability";
  target: string;
  id: string;
  severity: string;
  title: string;
  package?: string;
  installedVersion?: string;
  fixedVersion?: string;
}

function usage(): never {
  throw new Error(
    "usage: bun run scripts/verify-release-security.ts --image <image> --output-dir <outside-repo-directory> [--assets-dir <release-assets-directory>]",
  );
}

function outsideRepository(path: string): string {
  const absolute = resolve(path);
  const pathFromRepo = relative(repoRoot, absolute);
  if (
    pathFromRepo === "" ||
    (pathFromRepo !== ".." && !pathFromRepo.startsWith(`..${sep}`) && !isAbsolute(pathFromRepo))
  ) {
    throw new Error("security evidence output must be outside the repository");
  }
  return absolute;
}

export function parseReleaseSecurityArgs(args: string[]): ReleaseSecurityArgs {
  let image: string | undefined;
  let outputDir: string | undefined;
  let assetsDir: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (!value || value.startsWith("--")) usage();
    if (flag === "--image") image = value;
    else if (flag === "--output-dir") outputDir = outsideRepository(value);
    else if (flag === "--assets-dir") assetsDir = resolve(value);
    else usage();
    index += 1;
  }
  if (!image || !outputDir) usage();
  return { image, outputDir, ...(assetsDir ? { assetsDir } : {}) };
}

function isHighOrCritical(value: unknown): boolean {
  return value === "HIGH" || value === "CRITICAL";
}

export function trivyHighCriticalFindings(report: unknown): TrivyFinding[] {
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    throw new Error("Trivy did not produce a JSON object");
  }
  const results = (report as { Results?: unknown }).Results;
  if (!Array.isArray(results)) throw new Error("Trivy report has no results");
  const findings: TrivyFinding[] = [];
  for (const rawResult of results) {
    if (!rawResult || typeof rawResult !== "object" || Array.isArray(rawResult)) continue;
    const result = rawResult as Record<string, unknown>;
    const target = typeof result.Target === "string" ? result.Target : "unknown";
    const add = (kind: TrivyFinding["kind"], values: unknown) => {
      if (!Array.isArray(values)) return;
      for (const raw of values) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
        const item = raw as Record<string, unknown>;
        if (!isHighOrCritical(item.Severity)) continue;
        const id = String(item.VulnerabilityID ?? item.ID ?? item.RuleID ?? "unknown");
        const title = String(item.Title ?? item.Message ?? item.Description ?? id);
        findings.push({
          kind,
          target,
          id,
          severity: String(item.Severity),
          title,
          ...(typeof item.PkgName === "string" ? { package: item.PkgName } : {}),
          ...(typeof item.InstalledVersion === "string"
            ? { installedVersion: item.InstalledVersion }
            : {}),
          ...(typeof item.FixedVersion === "string" ? { fixedVersion: item.FixedVersion } : {}),
        });
      }
    };
    add("vulnerability", result.Vulnerabilities);
    add("secret", result.Secrets);
    add("misconfiguration", result.Misconfigurations);
  }
  return findings;
}

async function run(command: string[], cwd = repoRoot): Promise<void> {
  const child = Bun.spawn(command, { cwd, stdout: "inherit", stderr: "inherit" });
  if ((await child.exited) !== 0) throw new Error(`${command[0]} failed`);
}

async function capture(command: string[], cwd = repoRoot): Promise<string> {
  const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`${command[0]} failed: ${stderr.trim()}`);
  return stdout.trim();
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(
      `could not read JSON evidence ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function inventory(
  directory: string,
  base = directory,
): Promise<Array<{ path: string; sha256: string }>> {
  const entries = await readdir(directory, { withFileTypes: true });
  const records: Array<{ path: string; sha256: string }> = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) records.push(...(await inventory(path, base)));
    else if (entry.isFile()) {
      records.push({
        path: relative(base, path),
        sha256: createHash("sha256")
          .update(await readFile(path))
          .digest("hex"),
      });
    }
  }
  return records;
}

async function verifyRuntimeInventory(runtimeDir: string): Promise<void> {
  const present = new Set((await inventory(runtimeDir)).map((entry) => entry.path));
  for (const required of REQUIRED_RUNTIME_FILES) {
    if (!present.has(required)) throw new Error(`runtime image is missing ${required}`);
  }
}

function imageIdentity(inspect: unknown): { id: string; repo_digests: string[] } {
  if (!Array.isArray(inspect) || inspect.length !== 1) {
    throw new Error("docker image inspect did not return one image");
  }
  const image = inspect[0];
  if (!image || typeof image !== "object" || Array.isArray(image)) {
    throw new Error("docker image inspect returned invalid image metadata");
  }
  const values = image as Record<string, unknown>;
  if (typeof values.Id !== "string" || values.Id.length === 0) {
    throw new Error("docker image inspect returned no image id");
  }
  return {
    id: values.Id,
    repo_digests: Array.isArray(values.RepoDigests)
      ? values.RepoDigests.filter((digest): digest is string => typeof digest === "string")
      : [],
  };
}

async function main() {
  const args = parseReleaseSecurityArgs(process.argv.slice(2));
  await mkdir(args.outputDir, { recursive: true });
  const trivyReport = join(args.outputDir, "trivy.json");
  const sbom = join(args.outputDir, "sbom.cdx.json");
  const image = join(args.outputDir, "image.json");
  const runtime = join(args.outputDir, "runtime");
  await rm(runtime, { recursive: true, force: true });

  await run([
    "trivy",
    "image",
    "--format",
    "json",
    "--scanners",
    "vuln,secret,misconfig",
    "--severity",
    "HIGH,CRITICAL",
    "--output",
    trivyReport,
    args.image,
  ]);
  await run(["trivy", "image", "--format", "cyclonedx", "--output", sbom, args.image]);
  const inspect = Bun.spawn(["docker", "image", "inspect", args.image], {
    cwd: repoRoot,
    stdout: Bun.file(image),
    stderr: "inherit",
  });
  if ((await inspect.exited) !== 0) throw new Error("docker image inspect failed");

  const create = Bun.spawn(["docker", "create", args.image], { cwd: repoRoot, stdout: "pipe" });
  if ((await create.exited) !== 0) throw new Error("docker create failed");
  const container = (await new Response(create.stdout).text()).trim();
  if (!container) throw new Error("docker create returned no container id");
  try {
    await run(["docker", "cp", `${container}:/usr/local/share/subkit/.`, runtime]);
  } finally {
    await run(["docker", "rm", container]);
  }
  await verifyRuntimeInventory(runtime);

  const scan = await readJson(trivyReport);
  const inspectedImage = await readJson(image);
  const findings = trivyHighCriticalFindings(scan);
  const evidence = {
    image: args.image,
    image_identity: imageIdentity(inspectedImage),
    scanner_version: await capture(["trivy", "--version"]),
    generated_at: new Date().toISOString(),
    findings,
    runtime: await inventory(runtime),
    ...(args.assetsDir ? { release_assets: await inventory(args.assetsDir) } : {}),
  };
  await Bun.write(
    join(args.outputDir, "security-summary.json"),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
  if (findings.length > 0) {
    throw new Error(`security scan found ${findings.length} untriaged HIGH/CRITICAL findings`);
  }
}

if (import.meta.main) await main();
