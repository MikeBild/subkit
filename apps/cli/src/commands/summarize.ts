import { readFileSync } from "node:fs";
import { defineCommand } from "citty";
import type { EngineClient } from "../engine-client.ts";
import { clientArgs, makeClient } from "../utils/client-args.ts";
import { emitOne } from "../utils/format.ts";

function resolvePrompt(args: Record<string, unknown>): string {
  if (typeof args.prompt === "string" && args.prompt.trim().length > 0) {
    return args.prompt.trim();
  }
  if (typeof args.file === "string" && args.file.trim().length > 0) {
    return readFileSync(args.file, "utf8");
  }
  throw new Error("Provide either --prompt or --file.");
}

export async function runSummarize(
  client: EngineClient,
  asJson: boolean,
  prompt: string,
): Promise<number> {
  const result = await client.summarize({ prompt });
  emitOne(asJson, result as unknown as Record<string, unknown>);
  return 0;
}

export const summarizeCommand = defineCommand({
  meta: { name: "summarize", description: "Summarize arbitrary text via the engine" },
  args: {
    ...clientArgs,
    prompt: { type: "string", description: "Inline text to summarize" },
    file: { type: "string", description: "Path to a text file to summarize" },
  },
  async run({ args }) {
    const { client, asJson } = makeClient(args as Record<string, unknown>);
    await runSummarize(client, asJson, resolvePrompt(args as Record<string, unknown>));
  },
});
