import { describe, expect, test } from "bun:test";
import { decide, type Outdated, parseOutdated, report } from "../deps-update.ts";

const TABLE = `bun outdated v1.4.5 (a7733435c)
|---------------------------------------------------------|
| Package              | Current | Update  | Latest  |
|----------------------|---------|---------|---------|
| ai                   | 7.0.177 | 7.0.179 | 7.0.179 |
|----------------------|---------|---------|---------|
| lucide-react (dev)   | 1.76.0  | 1.77.0  | 1.77.0  |
|----------------------|---------|---------|---------|
| @hono/node-server    | 1.19.19 | 1.19.19 | 2.1.11  |
|---------------------------------------------------------|
`;

const dep = (name: string, current: string, update: string, latest = update): Outdated => ({
  name,
  current,
  update,
  latest,
});

describe("parseOutdated", () => {
  test("reads every row and drops the dev marker", () => {
    expect(parseOutdated(TABLE)).toEqual([
      dep("ai", "7.0.177", "7.0.179"),
      dep("lucide-react", "1.76.0", "1.77.0"),
      dep("@hono/node-server", "1.19.19", "1.19.19", "2.1.11"),
    ]);
  });

  test("an empty report has no rows", () => {
    expect(parseOutdated("bun outdated v1.4.5\n")).toEqual([]);
  });
});

describe("decide", () => {
  test("applies minor and patch updates inside a caret or tilde range", () => {
    const decisions = decide([dep("ai", "7.0.177", "7.0.179"), dep("hono", "4.13.19", "4.14.0")], {
      dependencies: { ai: "^7.0.177" },
      devDependencies: { hono: "~4.13.19" },
    });
    expect(decisions.map((d) => d.kind)).toEqual(["apply", "apply"]);
  });

  test("holds pins, patches, overrides, local files and new majors", () => {
    const decisions = decide(
      [
        dep("zod", "4.6.7", "4.6.7", "4.7.0"),
        dep("pg-boss", "12.38.2", "12.38.2", "12.39.0"),
        dep("sharp", "0.35.5", "0.35.6"),
        dep("xlsx", "0.20.0", "0.20.1"),
        dep("@hono/node-server", "1.19.19", "1.19.19", "2.1.11"),
        dep("unknown", "1.0.0", "1.0.1"),
      ],
      {
        dependencies: {
          zod: "4.6.7",
          "pg-boss": "^12.38.2",
          xlsx: "file:vendor/xlsx.tgz",
          "@hono/node-server": "^1.19.19",
        },
        devDependencies: { sharp: "^0.35.5" },
        overrides: { sharp: "0.35.5" },
        patchedDependencies: { "pg-boss@12.38.2": "patches/pg-boss@12.38.2.patch" },
      },
    );
    expect(decisions.map((d) => (d.kind === "hold" ? d.reason : d.kind))).toEqual([
      "exact pin, update by hand",
      "patched, update the patch by hand",
      "pinned by overrides",
      "not from the registry",
      "new major, update by hand",
      "not a direct dependency",
    ]);
  });
});

describe("report", () => {
  test("names each update and each hold with its reason", () => {
    const lines = report(".", [
      { kind: "apply", dep: dep("ai", "7.0.177", "7.0.179") },
      {
        kind: "hold",
        dep: dep("zod", "4.6.7", "4.6.7", "4.7.0"),
        reason: "exact pin, update by hand",
      },
    ]);
    expect(lines).toEqual([
      ".: update ai 7.0.177 → 7.0.179",
      ".: hold zod 4.6.7 (latest 4.7.0): exact pin, update by hand",
    ]);
    expect(report("apps/desktop", [])).toEqual(["apps/desktop: up to date"]);
  });
});
