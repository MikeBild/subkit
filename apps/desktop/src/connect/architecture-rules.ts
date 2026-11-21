export type Layer =
  | "entry"
  | "page"
  | "feature"
  | "adapter"
  | "domain"
  | "ui"
  | "lib"
  | "shared"
  | "design-system"
  | "package";

const UI_LEVELS = ["atoms", "molecules", "organisms", "templates"] as const;

export interface SourceFile {
  path: string;
  source: string;
}

export interface Target {
  layer: Layer;
  path: string;
}

const ALLOWED: Record<Layer, Layer[]> = {
  entry: ["page", "adapter", "shared", "package"],
  page: ["page", "feature", "ui", "adapter", "domain", "lib", "shared", "design-system", "package"],
  feature: ["feature", "ui", "domain", "adapter", "lib", "shared", "design-system", "package"],
  adapter: ["adapter", "domain", "lib", "shared", "package"],
  domain: ["domain", "shared", "design-system"],
  ui: ["ui", "design-system", "package"],
  lib: ["lib", "shared"],
  shared: ["shared"],
  "design-system": [],
  package: [],
};

export function layerOf(path: string): Layer {
  if (path === "main.tsx") return "entry";
  const [top] = path.split("/");
  switch (top) {
    case "pages":
      return "page";
    case "features":
      return "feature";
    case "adapter":
      return "adapter";
    case "domain":
      return "domain";
    case "ui":
      return "ui";
    case "lib":
      return "lib";
    default:
      return "shared";
  }
}

function normalize(parts: string[]): string {
  const out: string[] = [];
  for (const part of parts) {
    if (part === "..") out.pop();
    else if (part !== "." && part !== "") out.push(part);
  }
  return out.join("/");
}

export function targetOf(from: string, specifier: string): Target {
  if (specifier.startsWith("@ui/")) return { layer: "design-system", path: specifier };
  if (!specifier.startsWith(".")) return { layer: "package", path: specifier };
  const resolved = normalize([
    "src",
    "connect",
    ...from.split("/").slice(0, -1),
    ...specifier.split("/"),
  ]);
  if (!resolved.startsWith("src/connect/")) return { layer: "shared", path: resolved };
  const local = resolved.slice("src/connect/".length);
  return { layer: layerOf(local), path: local };
}

const IMPORT = /(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']/g;

export function importsOf(source: string): string[] {
  return [...source.matchAll(IMPORT)].map((match) => match[1] ?? "");
}

function uiLevel(path: string): number {
  const level = path.split("/")[1] ?? "";
  const index = UI_LEVELS.indexOf(level as (typeof UI_LEVELS)[number]);
  return index === -1 ? UI_LEVELS.length : index;
}

function featureOf(path: string): string {
  return path.split("/")[1] ?? "";
}

const DOMAIN_PACKAGES = /^(react|react-dom|lucide-react|radix-ui)(\/|$)/;
const IMPURE =
  /\b(Date\.now|new Date\(|Math\.random|setTimeout|setInterval|window\.\w|document\.\w|fetch\()/;

const INTERACTIVE = /<(Button|BusyButton|Input|Switch|ToggleGroupItem|button|a)[\s>/]/g;

function tagAt(source: string, start: number): string {
  let depth = 0;
  for (let index = start; index < source.length; index++) {
    const char = source[index];
    if (char === "{") depth++;
    else if (char === "}") depth--;
    else if (char === ">" && depth === 0) return source.slice(start, index);
  }
  return source.slice(start);
}

export function missingTestIds(files: SourceFile[]): string[] {
  const out: string[] = [];
  for (const file of files) {
    if (/\.test\.tsx?$/.test(file.path) || !file.path.endsWith(".tsx")) continue;
    for (const match of file.source.matchAll(INTERACTIVE)) {
      const tag = tagAt(file.source, match.index ?? 0);
      if (tag.includes("data-testid") || tag.includes("{...props}")) continue;
      const line = file.source.slice(0, match.index).split("\n").length;
      out.push(`${file.path}:${line} <${match[1]}> has no data-testid`);
    }
  }
  return out;
}

export function violations(files: SourceFile[]): string[] {
  const out: string[] = [];
  for (const file of files) {
    const from = layerOf(file.path);
    const isTest = /\.test\.tsx?$/.test(file.path);
    for (const specifier of importsOf(file.source)) {
      if (specifier.startsWith("bun")) continue;
      const target = targetOf(file.path, specifier);
      const where = `${file.path} → ${specifier}`;
      const testHelper = isTest && target.layer === "lib";
      if (!testHelper && !ALLOWED[from].includes(target.layer)) {
        out.push(`${where}: ${from} may not import ${target.layer}`);
        continue;
      }
      if (from === "domain" && target.layer === "design-system" && specifier !== "@ui/lib/errors") {
        out.push(`${where}: the domain uses only the shared error catalog`);
      }
      if (from === "domain" && DOMAIN_PACKAGES.test(specifier)) {
        out.push(`${where}: the domain stays free of UI packages`);
      }
      if (from === "ui" && target.layer === "ui" && uiLevel(target.path) > uiLevel(file.path)) {
        out.push(`${where}: an Atomic Design level may not use a higher level`);
      }
      if (target.layer === "feature" && !isTest) {
        const own = from === "feature" && featureOf(file.path) === featureOf(target.path);
        const publicApi = target.path === `features/${featureOf(target.path)}/index.ts`;
        if (!own && !publicApi) out.push(`${where}: use the feature's index.ts`);
      }
    }
    if (from === "domain" && !isTest && IMPURE.test(file.source)) {
      out.push(`${file.path}: the domain gets time and ids as parameters`);
    }
    const bridgeHome = from === "adapter" || from === "entry";
    if (
      !bridgeHome &&
      !isTest &&
      /subkitConnect|ConnectBridge|CONNECT_CHANNELS/.test(file.source)
    ) {
      out.push(`${file.path}: only the adapter talks to the preload bridge`);
    }
  }
  return out;
}
