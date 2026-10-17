import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export interface NoticePackage {
  name: string;
  version: string;
  license: unknown;
  texts: Array<{ name: string; sha256: string; text: string }>;
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
    if (!item.texts.length) parts.push("UNVERIFIED: no installed notice text found");
    for (const notice of item.texts)
      parts.push(`File: ${notice.name}`, `SHA-256: ${notice.sha256}`, notice.text);
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
  const packages = await collectNotices(process.cwd(), inputs);
  if (!packages.length) throw new Error("No third-party packages found");
  process.stdout.write(renderNoticeDraft(packages));
  process.stderr.write(
    `${packages.length} packages; ${packages.filter((item) => !item.texts.length).length} missing notices. Draft only.\n`,
  );
}
