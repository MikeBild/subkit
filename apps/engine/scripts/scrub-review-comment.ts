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
// stdin → scrubbed stdout. Exits non-zero on empty input so the
// caller's `gh pr comment --body-file` path doesn't silently post an
// empty comment when the model produced nothing — empty bodies are
// rejected by `gh` and the resulting workflow failure would otherwise
// look mysterious.

import { scrubString } from "@shared/redaction.ts";

async function readAll(stream: NodeJS.ReadStream): Promise<string> {
  let buf = "";
  stream.setEncoding("utf8");
  for await (const chunk of stream) buf += chunk;
  return buf;
}

const input = await readAll(process.stdin);
if (input.trim() === "") {
  process.stderr.write("scrub-review-comment: stdin was empty; refusing to emit\n");
  process.exit(2);
}
process.stdout.write(scrubString(input));
