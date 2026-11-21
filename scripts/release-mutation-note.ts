import { readFileSync } from "node:fs";
import { releaseNotesMutationLine } from "./lib/mutation-deferral.ts";
import { releaseGateMutation } from "./release-gate-provenance.ts";

const [filename, tag] = process.argv.slice(2);
if (!filename || !tag) throw new Error("Expected gate status file and tag");
process.stdout.write(
  releaseNotesMutationLine(releaseGateMutation(JSON.parse(readFileSync(filename, "utf8")), tag)),
);
