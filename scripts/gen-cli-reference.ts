// Generate docs/developers/cli-reference.md — the non-interactive
// `sk <subcommand>` surface.
//
// Reads the live SUB_COMMANDS inventory exported from
// apps/sk/src/index.ts (bare `sk` opens the REPL; every entry here is a
// scriptable subcommand). For each command we print its description,
// the UX permission gate (`requires`), and any nested subcommands —
// resolved straight from the citty `CommandDef` metadata so the table
// can never drift from the registered commands.
//
// EVERY ARGUMENT IS LISTED, not just command names. The CLI is the authoring
// surface, and this file is what a coding agent reads (directly, or through
// `docs/llms-full.txt`, which concatenates it verbatim). Telling an agent that
// `sk connectors create` exists while leaving `--file` to `--help` means the
// agent has to guess or shell out to discover it — and a guessed flag is a
// failed command. Anything absent here is absent from the agent's world.
//
// Output is byte-stable: commands sorted alphabetically, no timestamps.
//
// Wired into `bun run gen:cli-reference` (writes the file) and
// `bun run check:cli-reference-drift` (regenerate + git-diff gate).
//
// Usage:
//   bun run scripts/gen-cli-reference.ts > docs/developers/cli-reference.md

import { SUB_COMMANDS } from "../apps/sk/src/index.ts";

// citty's CommandDef metadata is loosely typed (meta + subCommands may
// each be a value or a resolver). Narrow just what we read.
type Resolvable<T> = T | (() => T | Promise<T>);
interface AnyArgDef {
  type?: string;
  required?: boolean;
  default?: unknown;
  description?: string;
  alias?: string | string[];
}
interface AnyCommandDef {
  meta?: Resolvable<{ name?: string; description?: string } | undefined>;
  args?: Record<string, AnyArgDef>;
  subCommands?: Resolvable<Record<string, AnyCommandDef> | undefined>;
}

async function resolve<T>(value: Resolvable<T>): Promise<T> {
  return typeof value === "function" ? await (value as () => T | Promise<T>)() : value;
}

async function descriptionOf(cmd: AnyCommandDef): Promise<string> {
  const meta = await resolve(cmd.meta);
  return meta?.description ?? "";
}

async function subCommandNames(cmd: AnyCommandDef): Promise<string[]> {
  const subs = await resolve(cmd.subCommands);
  if (!subs) return [];
  return Object.keys(subs).sort((a, b) => a.localeCompare(b));
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|");
}

/** One argument as a compact bullet: how to spell it, then what it is.
 *
 *  Deliberately not a table — this file is concatenated into
 *  `docs/llms-full.txt`, and a table per subcommand across ~200 subcommands
 *  costs far more tokens than the same facts as bullets. */
function renderArg(name: string, def: AnyArgDef): string {
  const positional = def.type === "positional";
  const spelling = positional ? `<${name}>` : `--${name}`;
  const bits: string[] = [];
  if (positional) bits.push("positional");
  else if (def.type && def.type !== "boolean") bits.push(def.type);
  if (def.required) bits.push("required");
  if (def.default !== undefined) bits.push(`default: ${String(def.default)}`);
  const aliases = def.alias
    ? (Array.isArray(def.alias) ? def.alias : [def.alias]).map((a) => `-${a}`)
    : [];
  if (aliases.length > 0) bits.push(`alias ${aliases.join(", ")}`);
  const meta = bits.length > 0 ? ` (${bits.join(", ")})` : "";
  const description = def.description ? ` — ${def.description}` : "";
  return `- \`${spelling}\`${meta}${description}`;
}

/** A command and its subcommands, with every argument spelled out. */
async function renderCommandDetail(name: string, cmd: AnyCommandDef): Promise<string[]> {
  const out: string[] = ["", `### \`sk ${name}\``, ""];
  const description = await descriptionOf(cmd);
  if (description) out.push(description, "");

  const ownArgs = Object.entries(cmd.args ?? {});
  if (ownArgs.length > 0) {
    for (const [argName, def] of ownArgs) out.push(renderArg(argName, def));
    out.push("");
  }

  const subs = await resolve(cmd.subCommands);
  for (const subName of Object.keys(subs ?? {}).sort((a, b) => a.localeCompare(b))) {
    const sub = subs?.[subName];
    if (!sub) continue;
    out.push(`#### \`sk ${name} ${subName}\``, "");
    const subDescription = await descriptionOf(sub);
    if (subDescription) out.push(subDescription, "");
    const args = Object.entries(sub.args ?? {});
    if (args.length === 0) {
      out.push("_No arguments._", "");
      continue;
    }
    for (const [argName, def] of args) out.push(renderArg(argName, def));
    out.push("");
  }
  return out;
}

async function main(): Promise<void> {
  const names = Object.keys(SUB_COMMANDS).sort((a, b) => a.localeCompare(b));

  const rows: string[] = [];
  const detail: string[] = [];
  for (const name of names) {
    const entry = SUB_COMMANDS[name];
    const cmd = entry.command as AnyCommandDef;
    const description = escapeCell(await descriptionOf(cmd));
    const requires = entry.requires ? `\`${entry.requires}\`` : "—";
    const subs = await subCommandNames(cmd);
    const subCell = subs.length > 0 ? subs.map((s) => `\`${s}\``).join(", ") : "—";
    rows.push(`| \`sk ${name}\` | ${requires} | ${description} | ${subCell} |`);
    detail.push(...(await renderCommandDetail(name, cmd)));
  }

  const lines: string[] = [
    "<!-- generated by scripts/gen-cli-reference.ts — do not edit by hand -->",
    "",
    "# sk CLI reference",
    "",
    "Every `sk` command and argument — and the surface authoring runs through:",
    "creating or changing a workflow, connector, knowledge source or skill is a",
    "definition edit, and definition edits belong here, where the change is a",
    "file you can read and a command you can re-run.",
    "",
    "Running bare `sk` opens the interactive REPL; every command below is",
    "scriptable and prints to stdout. The declarative path — `create --file`,",
    "`update --file`, `validate`, `preview` / `probe` — checks a definition",
    "*before* it exists rather than after, so a mistake costs an error message",
    "instead of a half-built connector someone has to clean up.",
    "",
    "The `requires` column is the persona-aware *visibility* gate used for",
    "`--help` filtering — the engine independently enforces permissions on",
    "every API call.",
    "",
    "| command | requires | description | subcommands |",
    "| ------- | -------- | ----------- | ----------- |",
    ...rows,
    "",
    "## Commands and arguments",
    "",
    "Every argument of every command. `<name>` is positional; `--name` is a flag.",
    ...detail,
  ];

  process.stdout.write(`${lines.join("\n").trimEnd()}\n`);
}

await main();
