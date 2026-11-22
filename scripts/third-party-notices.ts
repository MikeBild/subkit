import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { renderRuntimeNotices } from "./lib/runtime-notices.ts";

export interface NoticePackage {
  name: string;
  version: string;
  license: unknown;
  applied?: string;
  statements?: string[];
  texts: Array<{ name: string; sha256: string; text: string }>;
}

interface SupplementalNotice {
  name: string;
  version: string;
  qualification: string;
  license?: string;
  statement?: string;
  files?: Array<{ path: string; sha256: string; source: string }>;
}

interface ModelNotice {
  model: string;
  revision: string;
  upstream: string;
  license: string;
  qualification: string;
  attribution: string;
  files: Array<{ path: string; sha256: string; source: string }>;
}

export async function supplementNotices(
  packages: NoticePackage[],
  manifest: string,
): Promise<NoticePackage[]> {
  const entries = JSON.parse(await readFile(manifest, "utf8")) as SupplementalNotice[];
  if (!Array.isArray(entries)) throw new Error("Invalid supplemental notice manifest");
  const result = structuredClone(packages);
  for (const entry of entries) {
    const item = result.find((item) => item.name === entry.name && item.version === entry.version);
    if (!item) continue;
    const files = entry.files ?? [];
    if (
      !Array.isArray(files) ||
      !entry.qualification?.trim() ||
      (!files.length && !entry.license?.trim() && !entry.statement?.trim())
    )
      throw new Error("Supplemental notice evidence is missing");
    if (entry.license !== undefined) {
      if (!/^[A-Za-z0-9.+-]+( (OR|AND) [A-Za-z0-9.+-]+)*$/.test(entry.license))
        throw new Error("Invalid applied license expression");
      item.applied = entry.license;
    }
    if (entry.statement?.trim()) item.statements = [...(item.statements ?? []), entry.statement];
    for (const file of files) {
      if (!file.path || /[/\\]/.test(file.path) || !file.source?.trim())
        throw new Error("Invalid supplemental notice path or source");
      const bytes = await readFile(join(dirname(manifest), file.path));
      const hash = createHash("sha256").update(bytes).digest("hex");
      if (hash !== file.sha256 || !bytes.toString("utf8").trim())
        throw new Error("Supplemental notice checksum mismatch or empty text");
      item.texts.push({
        name: `${file.path}\nSource: ${file.source}\nQualification: ${entry.qualification}`,
        sha256: hash,
        text: bytes.toString("utf8"),
      });
    }
  }
  return result;
}

export async function collectNotices(root: string, inputs: string[]): Promise<NoticePackage[]> {
  root = resolve(root);
  const packages = new Map<string, NoticePackage>();
  const visited = new Set<string>();
  for (const input of [...new Set(inputs)].sort()) {
    const path = resolve(root, input);
    const local = relative(root, path);
    if (isAbsolute(local) || local === ".." || local.startsWith("../")) {
      throw new Error("Bundle input escapes the repository");
    }
    if (!local.split("/").includes("node_modules")) continue;
    let directory = dirname(path);
    let found = false;
    while (directory !== root) {
      if (visited.has(directory)) {
        found = true;
        break;
      }
      let metadata: { name?: string; version?: string; license?: unknown };
      try {
        metadata = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        directory = dirname(directory);
        continue;
      }
      if (!metadata.name || !metadata.version) {
        directory = dirname(directory);
        continue;
      }
      const texts: NoticePackage["texts"] = [];
      for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
        a.name.localeCompare(b.name, "en"),
      )) {
        if (!entry.isFile() || !/^(license|licence|copying|notice|copyright)/i.test(entry.name))
          continue;
        const bytes = await readFile(join(directory, entry.name));
        if (!bytes.toString("utf8").trim()) throw new Error("Empty package notice");
        texts.push({
          name: entry.name,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          text: bytes.toString("utf8"),
        });
      }
      const item = {
        name: metadata.name,
        version: metadata.version,
        license: metadata.license,
        texts,
      };
      const key = `${item.name}@${item.version}`;
      const prior = packages.get(key);
      if (prior && JSON.stringify(prior) !== JSON.stringify(item)) {
        throw new Error(`Conflicting notices for ${key}`);
      }
      packages.set(key, item);
      visited.add(directory);
      found = true;
      break;
    }
    if (!found) throw new Error(`Package metadata missing for ${local}`);
  }
  return [...packages.values()].sort((a, b) =>
    `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`, "en"),
  );
}

export function renderNoticeDraft(packages: NoticePackage[]): string {
  const parts = [
    "DRAFT — NOT A DISTRIBUTION APPROVAL",
    "Scope: supplied JavaScript bundle inputs and installed package-root notices only.",
    "Native binaries, embedded models, runtime components and legal review require separate evidence.",
  ];
  for (const item of packages) {
    parts.push("", "=".repeat(72), `${item.name}@${item.version}`);
    parts.push(`Declared license: ${JSON.stringify(item.license ?? null)}`);
    if (item.applied) parts.push(`Applied license: ${item.applied}`);
    for (const statement of item.statements ?? []) parts.push(`Statement: ${statement}`);
    if (!item.texts.length) parts.push("UNVERIFIED: no installed notice text found");
    for (const notice of item.texts)
      parts.push(`File: ${notice.name}`, `SHA-256: ${notice.sha256}`, notice.text);
  }
  return `${parts.join("\n")}\n`;
}

export async function renderModelNotices(manifest: string, assets: string): Promise<string> {
  const entries = JSON.parse(await readFile(manifest, "utf8")) as ModelNotice[];
  const pinned = JSON.parse(await readFile(assets, "utf8")) as {
    model: string;
    revision: string;
    files: Array<{ local: string; sha256: string }>;
  };
  if (!Array.isArray(entries) || !entries.length)
    throw new Error("Model notice inventory is empty");
  const parts = ["", "EMBEDDED MODEL NOTICE DRAFT — NOT A DISTRIBUTION APPROVAL"];
  for (const entry of entries) {
    if (entry.model !== pinned.model || entry.revision !== pinned.revision)
      throw new Error("Model notice does not match the pinned embedding assets");
    if (
      !entry.upstream?.trim() ||
      !entry.license?.trim() ||
      !entry.qualification?.trim() ||
      !entry.attribution?.trim() ||
      !Array.isArray(entry.files) ||
      !entry.files.length
    )
      throw new Error("Model notice evidence is missing");
    parts.push(
      "",
      "=".repeat(72),
      `${entry.model}@${entry.revision}`,
      `Upstream model: ${entry.upstream}`,
      `Applied license: ${entry.license}`,
      `Attribution: ${entry.attribution}`,
      `Qualification: ${entry.qualification}`,
      ...pinned.files.map((file) => `Asset: ${file.local} SHA-256: ${file.sha256}`),
    );
    for (const file of entry.files) {
      if (!file.path || /[/\\]/.test(file.path) || !file.source?.startsWith("https://"))
        throw new Error("Invalid model notice path or source");
      const bytes = await readFile(join(dirname(manifest), file.path));
      const hash = createHash("sha256").update(bytes).digest("hex");
      if (hash !== file.sha256 || !bytes.toString("utf8").trim())
        throw new Error("Model notice checksum mismatch or empty text");
      parts.push(
        `File: ${file.path}`,
        `Source: ${file.source}`,
        `SHA-256: ${hash}`,
        bytes.toString("utf8"),
      );
    }
  }
  return `${parts.join("\n")}\n`;
}

export async function noticeInputs(graph: string): Promise<string[]> {
  const data = JSON.parse(await readFile(graph, "utf8"));
  if (data.inputs && typeof data.inputs === "object" && !Array.isArray(data.inputs))
    return Object.keys(data.inputs);
  if (
    data.version === 3 &&
    Array.isArray(data.sources) &&
    data.sources.every((source: unknown) => typeof source === "string") &&
    (data.sourceRoot === undefined || typeof data.sourceRoot === "string")
  ) {
    const sourceRoot = data.sourceRoot ?? "";
    if ([sourceRoot, ...data.sources].some((value: string) => /^[a-z][a-z\d+.-]*:/i.test(value)))
      throw new Error("Source map must reference local source files");
    return data.sources.map((source: string) => resolve(dirname(graph), sourceRoot, source));
  }
  throw new Error("Invalid bundle input graph or source map");
}

if (import.meta.main) {
  const graphs = process.argv.slice(2);
  if (!graphs.length) throw new Error("Provide Bun bundle metafile or browser source map paths");
  const inputs: string[] = [];
  for (const graph of graphs) {
    inputs.push(...(await noticeInputs(graph)));
  }
  const packages = await supplementNotices(
    await collectNotices(process.cwd(), inputs),
    join(import.meta.dir, "../vendor/notices/manifest.json"),
  );
  if (!packages.length) throw new Error("No third-party packages found");
  const runtime = await renderRuntimeNotices(
    join(import.meta.dir, "../vendor/runtime-notices/manifest.json"),
    Bun.version,
    Bun.revision,
  );
  const models = await renderModelNotices(
    join(import.meta.dir, "../vendor/notices/models.json"),
    join(import.meta.dir, "../vendor/embedding-assets.json"),
  );
  process.stdout.write(renderNoticeDraft(packages) + runtime + models);
  process.stderr.write(
    `${packages.length} packages; ${packages.filter((item) => !item.texts.length).length} missing notices. Draft only.\n`,
  );
}
