type ArgDef = { type?: string };

export interface LeadingSplit {
  leading: string[];
  command: string | undefined;
  rest: string[];
}

export function splitLeadingOptions(
  rawArgs: readonly string[],
  argDefs: Record<string, ArgDef>,
): LeadingSplit {
  const leading: string[] = [];
  let i = 0;
  while (i < rawArgs.length) {
    const token = rawArgs[i]!;
    if (token === "--" || !token.startsWith("-") || token === "-") break;
    leading.push(token);
    i += 1;
    if (token.includes("=")) continue;
    const name = token.replace(/^-+/, "");
    const def = argDefs[name] ?? argDefs[name.replace(/^no-/, "")];
    if (def?.type === "string" && i < rawArgs.length) {
      leading.push(rawArgs[i]!);
      i += 1;
    }
  }
  return { leading, command: rawArgs[i], rest: rawArgs.slice(i + 1) };
}

export function profileOption(rawArgs: readonly string[]): string | undefined {
  let found: string | undefined;
  for (let i = 0; i < rawArgs.length; i += 1) {
    const token = rawArgs[i]!;
    if (token === "--") break;
    if (token.startsWith("--profile=")) found = token.slice("--profile=".length);
    else if (token === "--profile" && i + 1 < rawArgs.length) {
      found = rawArgs[i + 1];
      i += 1;
    }
  }
  const trimmed = found?.trim();
  return trimmed ? trimmed : undefined;
}
