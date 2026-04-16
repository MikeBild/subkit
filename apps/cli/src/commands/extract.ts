// `subkit extract <file>` — POST /v1/ai/extract

import { readFileSync } from "node:fs";
import { defineCommand } from "citty";
import { clientArgs, makeClient } from "../utils/client-args.ts";
import { printJson } from "../utils/format.ts";

export const extractCommand = defineCommand({
  meta: { name: "extract", description: "Extract structured JSON from a file" },
  args: {
    ...clientArgs,
    file: { type: "positional", description: "Path to sample file", required: true },
    hint: { type: "string", description: "Hint to the extractor" },
  },
  async run({ args }) {
    const { client } = makeClient(args as Record<string, unknown>);
    const sample = readFileSync(args.file as string, "utf8");
    const body: { sample: string; hint?: string } = { sample };
    if (typeof args.hint === "string" && args.hint) body.hint = args.hint;
    const result = await client.extract(body);
    printJson(result);
  },
});
