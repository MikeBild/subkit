import { reportCommandError } from "@cli-core/errors";
import { printJson } from "@cli-core/format";
import { defineCommand } from "citty";
import { resolveProfile } from "../config.ts";
import { EngineClient, type TenantBrandingUpdate } from "../engine-client.ts";

const commonArgs = {
  "engine-url": { type: "string" as const },
  "api-key": { type: "string" as const },
  profile: { type: "string" as const },
  json: { type: "boolean" as const },
};
function client(args: Record<string, unknown>) {
  const p = resolveProfile({
    engine_url: args["engine-url"] as string | undefined,
    api_key: args["api-key"] as string | undefined,
    profile: args.profile as string | undefined,
  });
  return new EngineClient({
    engine_url: p.engine_url,
    api_key: p.api_key,
    tenant: p.active_tenant_id,
  });
}
async function readInput(path: string): Promise<TenantBrandingUpdate> {
  const text = path === "-" ? await Bun.stdin.text() : await Bun.file(path).text();
  return JSON.parse(text) as TenantBrandingUpdate;
}
const getCommand = defineCommand({
  meta: { name: "get", description: "Read tenant branding" },
  args: commonArgs,
  async run({ args }) {
    try {
      printJson(await client(args).getTenantBranding());
    } catch (e) {
      reportCommandError(e, { json: true });
    }
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
    try {
      printJson(await client(args).updateTenantBranding(await readInput(args.input as string)));
    } catch (e) {
      reportCommandError(e, { json: true });
    }
  },
});
const resetCommand = defineCommand({
  meta: { name: "reset", description: "Reset branding at an expected revision" },
  args: { revision: { type: "positional" as const, required: true }, ...commonArgs },
  async run({ args }) {
    try {
      printJson(await client(args).resetTenantBranding(Number(args.revision)));
    } catch (e) {
      reportCommandError(e, { json: true });
    }
  },
});
const logoCommand = defineCommand({
  meta: { name: "logo", description: "Download normalized branding logo PNG" },
  args: {
    theme: { type: "positional" as const, required: true, description: "light or dark" },
    output: { type: "string" as const, description: "Output file, defaults to stdout" },
    revision: { type: "string" as const },
    ...commonArgs,
  },
  async run({ args }) {
    try {
      const theme =
        args.theme === "light" || args.theme === "dark"
          ? args.theme
          : (() => {
              throw new Error("theme must be light or dark");
            })();
      const bytes = await client(args).getTenantBrandingLogo({
        theme,
        ...(args.revision ? { revision: Number(args.revision) } : {}),
      });
      if (args.output) await Bun.write(args.output as string, bytes);
      else process.stdout.write(bytes);
    } catch (e) {
      reportCommandError(e, { json: Boolean(args.json) });
    }
  },
});
export const brandingCommand = defineCommand({
  meta: { name: "branding", description: "Read, update, reset, or download tenant branding" },
  subCommands: { get: getCommand, update: updateCommand, reset: resetCommand, logo: logoCommand },
});
