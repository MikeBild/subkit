import { defineCommand } from "citty";
import { clipperArchiveManifest, clipperArchivePath } from "../clipper-assets.ts";
import { installClipper, openChromeExtensions } from "../clipper-install.ts";

const installCommand = defineCommand({
  meta: { name: "install", description: "Install the local Chrome clipping extension" },
  args: {
    dir: { type: "string", description: "Installation directory" },
    "engine-url": { type: "string", description: "Engine address (default: active profile)" },
    open: {
      type: "boolean",
      description: "Open Chrome extensions after installing",
      default: true,
    },
  },
  async run({ args }) {
    const targetDir = await installClipper({
      archivePath: clipperArchivePath,
      manifest: clipperArchiveManifest,
      ...(typeof args.dir === "string" ? { targetDir: args.dir } : {}),
      ...(typeof args["engine-url"] === "string" ? { engineUrl: args["engine-url"] } : {}),
    });
    process.stdout.write(`subkit: clipping extension installed to ${targetDir}\n`);
    if (args.open !== false) {
      try {
        await openChromeExtensions();
      } catch {
        process.stderr.write("subkit: could not open Chrome automatically\n");
      }
    }
    process.stdout.write(
      "subkit: in Chrome, enable Developer mode, select Load unpacked, and choose the directory above. Reload the extension there after a future install.\n",
    );
  },
});

export const clipperCommand = defineCommand({
  meta: { name: "clipper", description: "Install the Chrome clipping extension" },
  subCommands: { install: installCommand },
});
