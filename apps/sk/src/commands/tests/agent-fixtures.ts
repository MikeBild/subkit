import { spyOn } from "bun:test";
import * as fs from "node:fs";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, sep } from "node:path";
import { AGENT_FILE_RELPATH } from "../agent.ts";

const fileExists = fs.existsSync;

const fixtureDirectories = [resolve(tmpdir()), realpathSync(tmpdir())].map((dir) => `${dir}${sep}`);

export const inheritedDeclarations = spyOn(fs, "existsSync").mockImplementation((path) => {
  if (
    typeof path === "string" &&
    path.endsWith(AGENT_FILE_RELPATH) &&
    !fixtureDirectories.some((directory) => resolve(path).startsWith(directory))
  )
    return false;
  return fileExists(path);
});
