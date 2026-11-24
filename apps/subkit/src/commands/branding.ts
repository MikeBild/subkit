import { printJson } from "@cli-core/format";
import { defineCommand } from "citty";
import type { TenantBrandingUpdate } from "../engine-client.ts";
import { makeClientFromArgs, withCommandErrors } from "./command-runtime.ts";

const commonArgs = {
  "engine-url": { type: "string" as const },
  "api-key": { type: "string" as const },
  profile: { type: "string" as const },
  json: { type: "boolean" as const },
};
async function readInput(path: string): Promise<TenantBrandingUpdate> {
  const text = path === "-" ? await Bun.stdin.text() : await Bun.file(path).text();
  return JSON.parse(text) as TenantBrandingUpdate;
}
const getCommand = defineCommand({
  meta: { name: "get", description: "Read tenant branding" },
  args: commonArgs,
  async run({ args }) {
    return withCommandErrors(
      async () => {
        printJson(await makeClientFromArgs(args).getTenantBranding());
      },
      { json: true },
    );
  },
});
const updateCommand = defineCommand({
  meta: {
    name: "update",
    description: "Replace branding from canonical JSON body (file or - for stdin)",
  },
  args: {
    input: { type: "positional" as const, required: true, description: "JSON file or -" },
    ...commonArgs,
  },
  async run({ args }) {
    return withCommandErrors(
      async () => {
        printJson(
          await makeClientFromArgs(args).updateTenantBranding(
            await readInput(args.input as string),
          ),
        );
      },
      { json: true },
    );
  },
});
const resetCommand = defineCommand({
  meta: { name: "reset", description: "Reset branding at an expected revision" },
  args: { revision: { type: "positional" as const, required: true }, ...commonArgs },
  async run({ args }) {
    return withCommandErrors(
      async () => {
        printJson(await makeClientFromArgs(args).resetTenantBranding(Number(args.revision)));
      },
      { json: true },
    );
  },
});
const logoCommand = defineCommand({
  meta: { name: "logo", description: "Download normalized branding logo PNG" },
  args: {
    theme: { type: "positional" as const, required: true, description: "light or dark" },
    output: { type: "string" as const, description: "Output file, defaults to stdout" },
    revision: {
      type: "string" as const,
      description: "Branding revision, defaults to the current revision",
    },
    ...commonArgs,
  },
  async run({ args }) {
    return withCommandErrors(
      async () => {
        const theme =
          args.theme === "light" || args.theme === "dark"
            ? args.theme
            : (() => {
                throw new Error("theme must be light or dark");
              })();
        const bytes = await makeClientFromArgs(args).getTenantBrandingLogo({
          theme,
          ...(args.revision ? { revision: Number(args.revision) } : {}),
        });
        if (args.output) await Bun.write(args.output as string, bytes);
        else process.stdout.write(bytes);
      },
      { json: Boolean(args.json) },
    );
  },
});
export const brandingCommand = defineCommand({
  meta: { name: "branding", description: "Read, update, reset, or download tenant branding" },
  subCommands: { get: getCommand, update: updateCommand, reset: resetCommand, logo: logoCommand },
});
