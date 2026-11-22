export const ENGINE_DESKTOP_TARGETS = [
  {
    name: "darwin-arm64",
    os: "mac",
    arch: "arm64",
    bunTarget: "bun-darwin-arm64",
    platform: "darwin",
    file: "engine",
  },
  {
    name: "windows-x64",
    os: "win",
    arch: "x64",
    bunTarget: "bun-windows-x64",
    platform: "win32",
    file: "engine.exe",
  },
] as const;

export type EngineDesktopTarget = (typeof ENGINE_DESKTOP_TARGETS)[number];

export const ENGINE_DESKTOP_TARGET_NAMES = ENGINE_DESKTOP_TARGETS.map((t) => t.name).join("|");

export type EngineDesktopSelection =
  | { readonly ok: true; readonly targets: readonly EngineDesktopTarget[] }
  | { readonly ok: false; readonly error: string };

export function selectEngineDesktopTargets(name: string | undefined): EngineDesktopSelection {
  if (name === undefined) return { ok: true, targets: ENGINE_DESKTOP_TARGETS };
  const target = ENGINE_DESKTOP_TARGETS.find((t) => t.name === name);
  if (target) return { ok: true, targets: [target] };
  return {
    ok: false,
    error: `unknown engine target ${name || "(empty)"}; use --target ${ENGINE_DESKTOP_TARGET_NAMES}`,
  };
}

export interface EngineDesktopArgs {
  readonly out: string | undefined;
  readonly targets: readonly EngineDesktopTarget[];
}

export function parseEngineDesktopArgs(
  argv: readonly string[],
):
  | { readonly ok: true; readonly args: EngineDesktopArgs }
  | { readonly ok: false; readonly error: string } {
  let out: string | undefined;
  let name: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--out" || arg === "--target") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--"))
        return { ok: false, error: `${arg} needs a value` };
      i++;
      if (arg === "--out") out = value;
      else if (name !== undefined) return { ok: false, error: "--target may be given once" };
      else name = value;
    } else return { ok: false, error: `unknown argument ${arg}` };
  }
  const selection = selectEngineDesktopTargets(name);
  return selection.ok ? { ok: true, args: { out, targets: selection.targets } } : selection;
}
