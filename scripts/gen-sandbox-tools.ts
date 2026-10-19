import { createHash } from "node:crypto";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const pinnedBun = (await Bun.file(resolve(root, ".bun-version")).text()).trim();
if (Bun.version !== pinnedBun)
  throw new Error(`Sandbox helpers require Bun ${pinnedBun}; current runtime is ${Bun.version}`);
const names = ["money", "csv", "date", "schema", "assert", "url", "xml", "template", "diff"];
const sources: Record<string, string> = {};
const notices = new Set<string>();
for (const name of names) {
  const result = await Bun.build({
    entrypoints: [
      resolve(root, `apps/engine/src/sandboxes/quickjs/stdlib/tools/entries/${name}.ts`),
    ],
    target: "browser",
    format: "iife",
    minify: true,
    plugins: [
      {
        name: "deterministic-polyfill-identifiers",
        setup(build) {
          build.onLoad({ filter: /core-js-pure\/internals\/uid\.js$/ }, async ({ path }) => {
            const source = await Bun.file(path).text();
            if (!source.includes("var postfix = Math.random();"))
              throw new Error("Polyfill identifier implementation changed");
            return {
              contents: source.replace("var postfix = Math.random();", "var postfix = 0.5;"),
              loader: "js",
            };
          });
        },
      },
    ],
  });
  if (!result.success || !result.outputs[0]) throw new Error(result.logs.join("\n"));
  const bundled = await result.outputs[0].text();
  const source = bundled.replace(/\/\/! [^\r\n]*(?:\r?\n|$)/g, (line) => {
    notices.add(line.trim());
    return "";
  });
  const destination = resolve(root, `apps/engine/src/sandboxes/quickjs/stdlib/helpers/${name}.js`);
  const declaration = "declare const source: string;\nexport default source;\n";
  const declarationPath = `${destination.slice(0, -3)}.d.ts`;
  if (process.argv.includes("--check")) {
    if ((await Bun.file(destination).text()) !== source)
      throw new Error(`Sandbox ${name} helper bundle drift; run bun run gen:sandbox-tools`);
    if ((await Bun.file(declarationPath).text()) !== declaration)
      throw new Error(`Sandbox ${name} helper declaration drift`);
  } else {
    await Bun.write(destination, source);
    await Bun.write(declarationPath, declaration);
  }
  sources[name] = source;
}

const coreBuild = await Bun.build({
  entrypoints: [resolve(root, "apps/engine/src/sandboxes/quickjs/stdlib/stdlib.js")],
  target: "browser",
  format: "iife",
  minify: true,
});
if (!coreBuild.success || !coreBuild.outputs[0]) throw new Error(coreBuild.logs.join("\n"));
const coreSource = await coreBuild.outputs[0].text();
const corePath = resolve(root, "apps/engine/src/sandboxes/quickjs/stdlib/helpers/core.js");
const coreDeclaration = "declare const source: string;\nexport default source;\n";
if (process.argv.includes("--check")) {
  if ((await Bun.file(corePath).text()) !== coreSource)
    throw new Error("Sandbox core bundle drift; run bun run gen:sandbox-tools");
  if ((await Bun.file(corePath.replace(/\.js$/, ".d.ts")).text()) !== coreDeclaration)
    throw new Error("Sandbox core declaration drift");
} else {
  await Bun.write(corePath, coreSource);
  await Bun.write(corePath.replace(/\.js$/, ".d.ts"), coreDeclaration);
}
sources.core = coreSource;
const bundleNames = [...names, "core"];

const libraries = [
  "big.js",
  "papaparse",
  "@js-joda/core",
  "@js-joda/timezone",
  "ajv",
  "core-js-pure",
  "fast-xml-parser",
];
const packages = await Promise.all(
  libraries.map(async (name) => {
    const data = await Bun.file(resolve(root, "node_modules", name, "package.json")).json();
    return { name, version: data.version as string, license: data.license as string };
  }),
);
const manifest =
  JSON.stringify(
    {
      sha256: createHash("sha256")
        .update(bundleNames.map((name) => sources[name]).join("\n"))
        .digest("hex"),
      bytes: bundleNames.reduce((total, name) => total + Buffer.byteLength(sources[name] ?? ""), 0),
      bundles: Object.fromEntries(
        bundleNames.map((name) => [
          name,
          {
            sha256: createHash("sha256")
              .update(sources[name] ?? "")
              .digest("hex"),
            bytes: Buffer.byteLength(sources[name] ?? ""),
          },
        ]),
      ),
      packages,
      legal_notices: [...notices].sort(),
      js_joda_license: await Bun.file(
        resolve(root, "node_modules", "@js-joda", "core", "LICENSE"),
      ).text(),
      timezone_data: "embedded full IANA dataset from the pinned timezone package",
      polyfill_identifiers: "monotonic counter with fixed suffix; no random source",
    },
    null,
    2,
  ) + "\n";
const manifestPath = resolve(
  root,
  "apps/engine/src/sandboxes/quickjs/stdlib/helpers.manifest.json",
);
if (process.argv.includes("--check")) {
  if ((await Bun.file(manifestPath).text()) !== manifest)
    throw new Error("Sandbox helper manifest drift");
} else await Bun.write(manifestPath, manifest);
