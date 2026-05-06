#!/usr/bin/env bun
//
// Scrubs the body of a `/review` comment before it is posted to a PR.
//
// The `claude-review` GitHub workflow runs the `/review` slash command,
// captures the model's stdout, then pipes it through this script before
// posting via `gh pr comment`. The repository's secret-pattern library
// (`packages/shared/src/redaction.ts`) is reused so the same patterns
// that protect runtime logs also protect the publicly-posted PR comment.
//
// Usage:
//   bun run apps/engine/scripts/scrub-review-comment.ts < raw.md > scrubbed.md
//
// stdin → scrubbed stdout. Non-zero exit only on read failure.

import { scrubString } from "../../../packages/shared/src/redaction.ts";

async function readAll(stream: NodeJS.ReadStream): Promise<string> {
  let buf = "";
  stream.setEncoding("utf8");
  for await (const chunk of stream) buf += chunk;
  return buf;
}

const input = await readAll(process.stdin);
process.stdout.write(scrubString(input));
