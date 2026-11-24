import { describe, expect, test } from "bun:test";
import type { CommandDef, Resolvable } from "citty";
import { SUB_COMMANDS } from "../../index.ts";

type AnyCommand = CommandDef<Record<string, never>>;

const resolve = async <T>(value: Resolvable<T> | undefined): Promise<T | undefined> =>
  typeof value === "function" ? await (value as () => T | Promise<T>)() : await value;

const findRunWithSubCommands = async (
  command: Resolvable<AnyCommand>,
  commandPath: string,
): Promise<string[]> => {
  const resolvedCommand = await resolve(command);
  if (!resolvedCommand) return [];
  const subCommands = (await resolve(resolvedCommand.subCommands)) ?? {};
  const subCommandNames = Object.keys(subCommands);
  const ownOffence =
    subCommandNames.length > 0 && typeof resolvedCommand.run === "function" ? [commandPath] : [];
  const nestedOffences = await Promise.all(
    subCommandNames.map((name) =>
      findRunWithSubCommands(subCommands[name] as Resolvable<AnyCommand>, `${commandPath} ${name}`),
    ),
  );
  return [...ownOffence, ...nestedOffences.flat()];
};

describe("CLI command tree invariants", () => {
  test("no command declares both subCommands and run, because citty would run the parent after the subcommand (#513)", async () => {
    const offences = await Promise.all(
      Object.entries(SUB_COMMANDS).map(([name, entry]) =>
        findRunWithSubCommands(entry.command as Resolvable<AnyCommand>, name),
      ),
    );
    expect(offences.flat()).toEqual([]);
  });
});
