import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface FakeCall {
  readonly argv: string[];
  readonly env: string[];
  readonly cwd: string;
  readonly stdin: string | null;
}

export type FakeReply = unknown;

export interface FakeHelper {
  readonly path: string;
  readonly state_root: string;
  script(scenario: Record<string, FakeReply | FakeReply[]>): void;
  calls(): FakeCall[];
  commands(): string[];
}

function commandOf(argv: readonly string[]): string {
  return (argv[0] === "--headed" ? argv[1] : argv[0]) ?? "";
}

export function createFakeHelper(): FakeHelper {
  const root = mkdtempSync(join(tmpdir(), "subkit-fake-helper-"));
  const path = join(root, "agent-desktop");
  const stateRoot = join(root, "state");
  writeFileSync(
    path,
    `#!${process.execPath}\nimport { serveFake } from ${JSON.stringify(import.meta.path)};\nserveFake();\n`,
  );
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o755);
  const calls = (): FakeCall[] => {
    const file = join(stateRoot, "calls.jsonl");
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as FakeCall);
  };
  return {
    path,
    state_root: stateRoot,
    script(scenario) {
      writeFileSync(join(stateRoot, "scenario.json"), JSON.stringify(scenario));
    },
    calls,
    commands: () => calls().map((call) => commandOf(call.argv)),
  };
}

export function serveFake(): void {
  const home = process.env.AGENT_DESKTOP_HOME;
  if (!home) throw new Error("AGENT_DESKTOP_HOME is missing");
  const argv = process.argv.slice(2);
  const command = commandOf(argv);
  const stdin = argv.includes("--stdin") ? readFileSync(0, "utf8") : null;
  const log = join(home, "calls.jsonl");
  const earlier = existsSync(log)
    ? readFileSync(log, "utf8")
        .split("\n")
        .filter(Boolean)
        .filter((line) => commandOf((JSON.parse(line) as FakeCall).argv) === command).length
    : 0;
  const call: FakeCall = { argv, env: Object.keys(process.env).sort(), cwd: process.cwd(), stdin };
  appendFileSync(log, `${JSON.stringify(call)}\n`);
  const scenario = JSON.parse(readFileSync(join(home, "scenario.json"), "utf8")) as Record<
    string,
    FakeReply | FakeReply[]
  >;
  const entry = scenario[command];
  const reply = Array.isArray(entry) ? entry[Math.min(earlier, entry.length - 1)] : entry;
  if (reply === "hang") {
    setInterval(() => {}, 1000);
    return;
  }
  if (reply === undefined || reply === "garbage") {
    process.stdout.write("not an envelope\n");
    return;
  }
  process.stdout.write(`${JSON.stringify(reply)}\n`);
}
