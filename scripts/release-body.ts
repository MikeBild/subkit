#!/usr/bin/env bun

import { readFileSync } from "node:fs";
import { completeHighlights, highlightsFromBody, releaseBody } from "./lib/release-highlights.ts";

const [existingPath, notesPath] = process.argv.slice(2);
if (!existingPath || !notesPath) {
  console.error("usage: bun run scripts/release-body.ts <existing-body> <notes>");
  process.exit(2);
}
const highlights = completeHighlights(highlightsFromBody(readFileSync(existingPath, "utf8")));
if (!highlights) {
  console.error(`${existingPath} has no highlights in both languages`);
  process.exit(1);
}
process.stdout.write(releaseBody(highlights, readFileSync(notesPath, "utf8")));
