#!/usr/bin/env bun

import { readFileSync } from "node:fs";
import { highlightsFromBody, releaseBody } from "./lib/release-highlights.ts";

const [existingPath, notesPath] = process.argv.slice(2);
if (!existingPath || !notesPath) {
  console.error("usage: bun run scripts/release-body.ts <existing-body> <notes>");
  process.exit(2);
}
const en = highlightsFromBody(readFileSync(existingPath, "utf8"));
if (en.length === 0) {
  console.error(`${existingPath} has no English highlights`);
  process.exit(1);
}
process.stdout.write(releaseBody(en, readFileSync(notesPath, "utf8")));
