export type PostgresTarget = "darwin-arm64" | "win32-x64";

export const POSTGRES_TARGETS: readonly PostgresTarget[] = ["darwin-arm64", "win32-x64"];

export const POSTGRES_PROGRAMS = [
  "postgres",
  "initdb",
  "pg_ctl",
  "pg_isready",
  "pg_dump",
  "pg_restore",
] as const;

export type PostgresProgram = (typeof POSTGRES_PROGRAMS)[number];

export const POSTGRES_EXTENSIONS = ["plpgsql", "pgcrypto"] as const;

const SERVER_MODULE = /^(plpgsql|pgcrypto|dict_snowball|[a-z0-9_]+_and_[a-z0-9_]+)$/;
const MAC_RUNTIME_LIBRARY =
  /^lib(pq\.5|ssl\.3|crypto\.3|icu(data|i18n|uc)\.\d+|xml2\.\d+|zstd\.1|lz4\.1)\.dylib$/;
const WINDOWS_EXCLUDED_LIBRARY = /^(python|pkgconf|libxslt|libexslt|libecpg|libpgtypes)/i;
const SHARE_EXCLUDED = /^share\/(doc\/|psqlrc\.sample$|pg_service\.conf\.sample$)/;
const SHARE_EXTENSION = /^share\/extension\/(.+)$/;
const EXCLUDED_NOTICE_PACKAGES = /^(python|llvm|readline|libxslt|sqlite|mpdecimal|xz)/;
const SYSTEM_LIBRARY = /^(\/usr\/lib\/|\/System\/Library\/)/;

export function targetFor(platform: string, arch: string): PostgresTarget | null {
  const target = `${platform}-${arch}`;
  return (POSTGRES_TARGETS as readonly string[]).includes(target)
    ? (target as PostgresTarget)
    : null;
}

export function isWindows(target: PostgresTarget): boolean {
  return target.startsWith("win32");
}

export function programFile(target: PostgresTarget, program: PostgresProgram): string {
  return isWindows(target) ? `bin/${program}.exe` : `bin/${program}`;
}

function keepExtensionFile(name: string): boolean {
  return POSTGRES_EXTENSIONS.some(
    (extension) => name === `${extension}.control` || name.startsWith(`${extension}--`),
  );
}

export function keepBundlePath(path: string, target: PostgresTarget): boolean {
  if (path === "COPYRIGHT" || path === "LICENSE") return true;
  if (path.startsWith("share/")) {
    if (SHARE_EXCLUDED.test(path)) return false;
    const extension = SHARE_EXTENSION.exec(path);
    return extension ? keepExtensionFile(extension[1] ?? "") : true;
  }
  const notice = /^dependency-notices\/([^/]+)\//.exec(path);
  if (notice) return !EXCLUDED_NOTICE_PACKAGES.test(notice[1] ?? "");
  const [folder, name, ...rest] = path.split("/");
  if (!name || rest.length > 0) return false;
  if (isWindows(target)) {
    if (folder === "bin" && name.endsWith(".exe"))
      return (POSTGRES_PROGRAMS as readonly string[]).includes(name.slice(0, -4));
    if (folder === "bin" && name.endsWith(".dll")) return !WINDOWS_EXCLUDED_LIBRARY.test(name);
    if (folder === "lib" && name.endsWith(".dll")) return SERVER_MODULE.test(name.slice(0, -4));
    return false;
  }
  if (folder === "bin") return (POSTGRES_PROGRAMS as readonly string[]).includes(name);
  if (folder === "lib" && name.endsWith(".dylib"))
    return SERVER_MODULE.test(name.slice(0, -6)) || MAC_RUNTIME_LIBRARY.test(name);
  return false;
}

export function stripTopFolder(path: string): string | null {
  const normalized = path.replaceAll("\\", "/");
  const slash = normalized.indexOf("/");
  if (slash < 0) return null;
  const rest = normalized.slice(slash + 1);
  if (!rest || rest.split("/").some((segment) => segment === ".." || segment === "")) return null;
  return rest;
}

export interface LinkedFile {
  file: string;
  dependencies: string[];
}

export function parseOtoolDependencies(output: string): string[] {
  return output
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(" (compatibility")[0]?.trim() ?? "")
    .filter((line) => line.length > 0);
}

export function linkProblems(files: LinkedFile[], kept: ReadonlySet<string>): string[] {
  const problems: string[] = [];
  for (const { file, dependencies } of files) {
    const folder = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "";
    for (const dependency of dependencies) {
      if (SYSTEM_LIBRARY.test(dependency)) continue;
      if (!dependency.startsWith("@loader_path/")) {
        problems.push(`${file} links ${dependency} outside the bundle`);
        continue;
      }
      const parts = [...folder.split("/").filter(Boolean)];
      for (const segment of dependency.slice("@loader_path/".length).split("/")) {
        if (segment === "..") parts.pop();
        else if (segment !== ".") parts.push(segment);
      }
      const resolved = parts.join("/");
      if (resolved !== file && !kept.has(resolved)) problems.push(`${file} needs ${resolved}`);
    }
  }
  return problems.sort();
}
