import { reportCommandError } from "@cli-core/errors";
import { printJson } from "@cli-core/format";
import { defineCommand } from "citty";
import { resolveProfile } from "../config.ts";
import { EngineClient } from "../engine-client.ts";

const BINARY_EXT_TO_MIME: Record<string, string> = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xls": "application/vnd.ms-excel",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

function binaryMimeFor(filePath: string): string | null {
  const lower = filePath.toLowerCase();
  for (const [ext, mime] of Object.entries(BINARY_EXT_TO_MIME)) {
    if (lower.endsWith(ext)) return mime;
  }
  return null;
}

export const extractCommand = defineCommand({
  meta: {
    name: "extract",
    description: "Extract structured data from a file (LLM for text, native parsers for binary)",
  },
  args: {
    file: { type: "positional", required: true, description: "Path to sample file" },
    hint: { type: "string", description: "Hint to the LLM extractor (text inputs only)" },
  },
  async run({ args }) {
    const { readFileSync, statSync } = await import("node:fs");
    const { basename } = await import("node:path");
    const profile = resolveProfile();
    const client = new EngineClient({
      engine_url: profile.engine_url,
      api_key: profile.api_key,
      tenant: profile.active_tenant_id,
    });
    try {
      const path = String(args.file);
      statSync(path);
      const filename = basename(path);
      const binaryMime = binaryMimeFor(path);
      if (binaryMime) {
        const bytes = readFileSync(path);
        const result = await client.extractFile({
          buffer: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
          contentType: binaryMime,
          filename,
        });
        printJson(result);
        return;
      }
      const sample = readFileSync(path, "utf8");
      const extractBody: { sample: string; hint?: string } = { sample };
      if (args.hint) extractBody.hint = String(args.hint);
      const result = await client.extract(extractBody);
      printJson(result);
    } catch (err) {
      reportCommandError(err);
    }
  },
});
