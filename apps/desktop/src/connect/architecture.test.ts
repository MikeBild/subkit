import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
  importsOf,
  layerOf,
  missingTestIds,
  type SourceFile,
  targetOf,
  violations,
} from "./architecture-rules.ts";

const ROOT = import.meta.dir;

function sources(directory: string): SourceFile[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sources(path);
    if (!/\.tsx?$/.test(entry.name) || entry.name.startsWith("architecture")) return [];
    return [{ path: relative(ROOT, path), source: readFileSync(path, "utf8") }];
  });
}

describe("architecture of the sign-in window", () => {
  const files = sources(ROOT);

  test("the scan sees every layer", () => {
    const layers = new Set(files.map((file) => layerOf(file.path)));
    for (const layer of ["entry", "page", "feature", "adapter", "domain", "ui", "lib"] as const) {
      expect(layers.has(layer)).toBe(true);
    }
    expect(files.length).toBeGreaterThan(30);
  });

  test("dependencies point downward and only the adapter reaches the bridge", () => {
    expect(violations(files)).toEqual([]);
  });

  test("every interactive element carries a test id", () => {
    expect(missingTestIds(files)).toEqual([]);
  });

  test("every feature has a public index", () => {
    const features = new Set(
      files.filter((file) => layerOf(file.path) === "feature").map((f) => f.path.split("/")[1]),
    );
    for (const feature of features) {
      expect(files.some((file) => file.path === `features/${feature}/index.ts`)).toBe(true);
    }
  });
});

describe("architecture rules catch planted violations", () => {
  const planted = (path: string, source: string) => violations([{ path, source }]);

  test("ui may not know the domain, features or the adapter", () => {
    expect(
      planted("ui/atoms/x.tsx", 'import { decide } from "../../domain/index.ts";'),
    ).toHaveLength(1);
    expect(
      planted(
        "ui/molecules/x.tsx",
        'import { ConnectStep } from "../../features/connect/index.ts";',
      ),
    ).toHaveLength(1);
  });

  test("an atom may not use a molecule", () => {
    expect(
      planted("ui/atoms/x.tsx", 'import { BusyButton } from "../molecules/index.ts";'),
    ).toEqual([
      "ui/atoms/x.tsx → ../molecules/index.ts: an Atomic Design level may not use a higher level",
    ]);
  });

  test("a feature may use another feature only through its index", () => {
    expect(
      planted("features/sign-in/x.tsx", 'import { Result } from "../connect/connect-step.tsx";'),
    ).toHaveLength(1);
    expect(
      planted("features/sign-in/x.tsx", 'import { ConnectStep } from "../connect/index.ts";'),
    ).toEqual([]);
  });

  test("features and the domain never point up", () => {
    expect(
      planted("features/connect/x.tsx", 'import { SignInWindow } from "../../pages/index.ts";'),
    ).toHaveLength(1);
    expect(planted("domain/x.ts", 'import { useState } from "react";')).toHaveLength(1);
  });

  test("the domain stays pure", () => {
    const clockCall = ["Date", "now()"].join(".");
    const randomCall = ["Math", "random()"].join(".");
    expect(planted("domain/x.ts", `export const at = () => ${clockCall};`)).toEqual([
      "domain/x.ts: the domain gets time and ids as parameters",
    ]);
    expect(planted("domain/x.ts", `export const id = ${randomCall};`)).toHaveLength(1);
  });

  test("only the adapter and the entry point touch the bridge", () => {
    expect(planted("features/connect/x.tsx", "window.subkitConnect.login(origin);")).toHaveLength(
      1,
    );
    expect(planted("adapter/x.ts", "bridge: ConnectBridge")).toEqual([]);
  });

  test("imports are read from import and export statements", () => {
    expect(importsOf('import a from "x";\nexport { b } from "../y.ts";')).toEqual(["x", "../y.ts"]);
    expect(targetOf("domain/a.ts", "../../shared/ipc.ts")).toEqual({
      layer: "shared",
      path: "src/shared/ipc.ts",
    });
    expect(targetOf("pages/a.tsx", "../ui/index.ts")).toEqual({ layer: "ui", path: "ui/index.ts" });
  });

  test("an interactive element without a test id is caught", () => {
    const source = '<Button onClick={() => go()}>Go</Button>\n<Input data-testid="x" />';
    expect(missingTestIds([{ path: "features/x/X.tsx", source }])).toEqual([
      "features/x/X.tsx:1 <Button> has no data-testid",
    ]);
  });
});
