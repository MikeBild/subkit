import { plugin } from "bun";
import { rewriteUiSource } from "./ui-resolve.ts";

plugin({
  name: "subkit-ui-test-resolve",
  setup(build) {
    build.onLoad({ filter: /\/packages\/(ui|shared)\/src\/.*\.tsx?$/ }, async (args) => ({
      contents: rewriteUiSource(await Bun.file(args.path).text(), args.path),
      loader: args.path.endsWith(".tsx") ? "tsx" : "ts",
    }));
  },
});

Object.assign(globalThis, { __subkitDesktopUi: true });
