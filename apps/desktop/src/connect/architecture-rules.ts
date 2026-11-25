export type Layer =
  | "entry"
  | "page"
  | "feature"
  | "adapter"
  | "domain"
  | "lib"
  | "shared"
  | "design-system"
  | "package";

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
  page: ["page", "feature", "adapter", "domain", "lib", "shared", "design-system", "package"],
  feature: ["feature", "domain", "adapter", "lib", "shared", "design-system", "package"],
  adapter: ["adapter", "domain", "lib", "shared", "package"],
  domain: ["domain", "shared"],
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

export interface WindowRules {
  root: string;
  bridge: RegExp;
}

export const CONNECT_RULES: WindowRules = {
  root: "src/connect",
  bridge: /subkitConnect|ConnectBridge|CONNECT_CHANNELS/,
};

export const LIVE_RULES: WindowRules = {
  root: "src/live",
  bridge: /subkitLive|LiveBridge|LIVE_CHANNELS/,
};

export const SHELL_RULES: WindowRules = {
  root: "src/shell",
  bridge: /subkitShell|ShellBridge|SHELL_CHANNELS/,
};

export function targetOf(from: string, specifier: string, rules = CONNECT_RULES): Target {
  if (specifier.startsWith("@ui/")) return { layer: "design-system", path: specifier };
  if (specifier.startsWith("@shared/")) return { layer: "shared", path: specifier };
  if (!specifier.startsWith(".")) return { layer: "package", path: specifier };
  const resolved = normalize([
    ...rules.root.split("/"),
    ...from.split("/").slice(0, -1),
    ...specifier.split("/"),
  ]);
  if (!resolved.startsWith(`${rules.root}/`)) return { layer: "shared", path: resolved };
  const local = resolved.slice(rules.root.length + 1);
  return { layer: layerOf(local), path: local };
}

const IMPORT = /(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']/g;

export function importsOf(source: string): string[] {
  return [...source.matchAll(IMPORT)].map((match) => match[1] ?? "");
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

export function violations(files: SourceFile[], rules = CONNECT_RULES): string[] {
  const out: string[] = [];
  for (const file of files) {
    const from = layerOf(file.path);
    const isTest = /\.test\.tsx?$/.test(file.path);
    for (const specifier of importsOf(file.source)) {
      if (specifier.startsWith("bun")) continue;
      const target = targetOf(file.path, specifier, rules);
      const where = `${file.path} → ${specifier}`;
      const testHelper = isTest && target.layer === "lib";
      if (!testHelper && !ALLOWED[from].includes(target.layer)) {
        out.push(`${where}: ${from} may not import ${target.layer}`);
        continue;
      }
      if (from === "domain" && DOMAIN_PACKAGES.test(specifier)) {
        out.push(`${where}: the domain stays free of UI packages`);
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
    if (!bridgeHome && !isTest && rules.bridge.test(file.source)) {
      out.push(`${file.path}: only the adapter talks to the preload bridge`);
    }
  }
  return out;
}

export interface ModuleRules {
  root: string;
  reach: string[];
  packages: RegExp;
}

export const SHARED_MODULE_RULES: ModuleRules = {
  root: "src/shared",
  reach: ["src/shared"],
  packages: /^(zod|node:[a-z_/]+|@shared\/.+|@cli-core\/engine-api\/openapi)$/,
};

export const MAIN_MODULE_RULES: ModuleRules = {
  root: "src/main",
  reach: ["src/main", "src/shared", "src/runner", "vendor"],
  packages: /^(electron|zod|bun|node:[a-z_/]+|@shared\/.+|@cli-core\/release-public-key)$/,
};

export function moduleViolations(files: SourceFile[], rules: ModuleRules): string[] {
  const out: string[] = [];
  for (const file of files) {
    if (/\.test\.tsx?$/.test(file.path) || /\.fixture\.ts$/.test(file.path)) continue;
    for (const specifier of importsOf(file.source)) {
      const where = `${file.path} → ${specifier}`;
      if (!specifier.startsWith(".")) {
        if (!rules.packages.test(specifier)) out.push(`${where}: ${rules.root} may not use it`);
        continue;
      }
      const resolved = normalize([
        ...rules.root.split("/"),
        ...file.path.split("/").slice(0, -1),
        ...specifier.split("/"),
      ]);
      if (!rules.reach.some((root) => resolved.startsWith(`${root}/`)))
        out.push(`${where}: ${rules.root} may not reach ${resolved}`);
    }
  }
  return out;
}
