import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertCockpitDemoActionMarker,
  assertCockpitDemoMarker,
  cockpitDemoBaseUrl,
  cockpitDemoImage,
  cockpitDemoMarker,
  cockpitDemoStateDirectory,
  readCockpitDemoMarker,
  resolveCockpitDemoInstance,
} from "./cockpit-demo-instance.ts";

describe("cockpit demo instance identity", () => {
  test("preserves the default installation and isolates explicitly named instances", () => {
    const root = "/repo";
    const baseline = resolveCockpitDemoInstance({}, root);
    const alpha = resolveCockpitDemoInstance(
      {
        SUBKIT_DEMO_INSTANCE: "review-alpha",
        SUBKIT_TEST_PORT: "3301",
        SUBKIT_DEMO_DB_PORT: "55441",
      },
      root,
    );
    const beta = resolveCockpitDemoInstance(
      {
        SUBKIT_DEMO_INSTANCE: "review-beta",
        SUBKIT_TEST_PORT: "3302",
        SUBKIT_DEMO_DB_PORT: "55442",
      },
      root,
    );

    expect(baseline).toMatchObject({
      id: null,
      project: "subkit-cockpit-demo",
      apiPort: 3000,
      dbPort: 55439,
      baseUrl: "http://127.0.0.1:3000",
      stateDir: "/repo/.artifacts/cockpit-demo",
    });
    expect(alpha.project).toBe("subkit-cockpit-demo-review-alpha");
    expect(cockpitDemoImage(baseline)).toBe("subkit:cockpit-demo");
    expect(cockpitDemoImage(alpha)).toBe("subkit:cockpit-demo-review-alpha");
    expect(cockpitDemoImage(beta)).toBe("subkit:cockpit-demo-review-beta");
    expect(alpha.stateDir).toBe("/repo/.artifacts/cockpit-demo/review-alpha");
    expect(alpha.project).not.toBe(beta.project);
    expect(alpha.stateDir).not.toBe(beta.stateDir);
  });

  test("rejects malformed IDs and invalid or colliding ports", () => {
    for (const id of ["", "Upper", "../escape", "two words", "-leading", "trailing-"])
      expect(() => resolveCockpitDemoInstance({ SUBKIT_DEMO_INSTANCE: id }, "/repo")).toThrow();
    for (const port of ["0", "65536", "03000", "abc", "3000x"])
      expect(() => resolveCockpitDemoInstance({ SUBKIT_TEST_PORT: port }, "/repo")).toThrow();
    expect(() =>
      resolveCockpitDemoInstance(
        { SUBKIT_TEST_PORT: "4300", SUBKIT_DEMO_DB_PORT: "4300" },
        "/repo",
      ),
    ).toThrow("must differ");
    expect(() => resolveCockpitDemoInstance({ SUBKIT_DEMO_INSTANCE: "isolated" }, "/repo")).toThrow(
      "dedicated non-default",
    );
    expect(() =>
      resolveCockpitDemoInstance(
        { SUBKIT_DEMO_INSTANCE: "isolated", SUBKIT_TEST_PORT: "3301" },
        "/repo",
      ),
    ).toThrow("dedicated non-default");
  });

  test("keeps explicit verifier state paths inside the selected instance", () => {
    const instance = resolveCockpitDemoInstance(
      {
        SUBKIT_DEMO_INSTANCE: "state-check",
        SUBKIT_TEST_PORT: "3301",
        SUBKIT_DEMO_DB_PORT: "55441",
      },
      "/repo",
    );
    expect(cockpitDemoStateDirectory(instance, "/repo/.artifacts/cockpit-demo/state-check")).toBe(
      "/repo/.artifacts/cockpit-demo/state-check",
    );
    expect(() => cockpitDemoStateDirectory(instance, "/repo/.artifacts/cockpit-demo")).toThrow(
      "must match",
    );
  });

  test("binds named journey URLs to their loopback API port", () => {
    const defaultInstance = resolveCockpitDemoInstance({}, "/repo");
    expect(cockpitDemoBaseUrl(defaultInstance, "http://127.0.0.1:3000").origin).toBe(
      "http://127.0.0.1:3000",
    );
    expect(() => cockpitDemoBaseUrl(defaultInstance, "http://localhost:3000")).toThrow(
      "does not match",
    );
    expect(() => cockpitDemoBaseUrl(defaultInstance, "http://127.0.0.1:3001")).toThrow(
      "does not match",
    );
    const instance = resolveCockpitDemoInstance(
      {
        SUBKIT_DEMO_INSTANCE: "journey-check",
        SUBKIT_TEST_PORT: "3401",
        SUBKIT_DEMO_DB_PORT: "55451",
      },
      "/repo",
    );
    expect(cockpitDemoBaseUrl(instance).origin).toBe("http://127.0.0.1:3401");
    expect(() => cockpitDemoBaseUrl(instance, "http://localhost:3000")).toThrow("does not match");
    expect(() => cockpitDemoBaseUrl(instance, "https://localhost:3401")).toThrow("does not match");
  });

  test("binds reset authority to the exact derived project and ports", () => {
    const instance = resolveCockpitDemoInstance(
      {
        SUBKIT_DEMO_INSTANCE: "reset-check",
        SUBKIT_TEST_PORT: "3401",
        SUBKIT_DEMO_DB_PORT: "55451",
      },
      "/repo",
    );
    const marker = cockpitDemoMarker(instance, "sha256:image", "sha256:source");

    expect(marker).toMatchObject({
      project: "subkit-cockpit-demo-reset-check",
      apiPort: 3401,
      dbPort: 55451,
      image: "sha256:image",
      source: "sha256:source",
    });
    expect(() => assertCockpitDemoMarker(marker, instance)).not.toThrow();
    expect(() =>
      assertCockpitDemoMarker(marker, {
        ...instance,
        project: "subkit-cockpit-demo-someone-elses",
      }),
    ).toThrow("does not match");
    expect(() =>
      assertCockpitDemoMarker(marker, {
        ...instance,
        dbPort: 55452,
      }),
    ).toThrow("does not match");
    expect(() => assertCockpitDemoMarker(null, instance)).toThrow("missing or invalid");
    expect(() => assertCockpitDemoMarker(null, resolveCockpitDemoInstance({}, "/repo"))).toThrow(
      "missing or invalid",
    );
  });

  test("rejects a symlink marker before trusting Docker cleanup authority", () => {
    const root = mkdtempSync(join(tmpdir(), "subkit-demo-marker-"));
    try {
      const instance = resolveCockpitDemoInstance({}, root);
      mkdirSync(instance.stateDir, { recursive: true });
      const target = join(root, "outside.json");
      writeFileSync(target, JSON.stringify(cockpitDemoMarker(instance, "sha256:image", "source")));
      symlinkSync(target, join(instance.stateDir, "instance.json"));

      expect(() => readCockpitDemoMarker(instance)).toThrow("regular file");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects a hard-linked marker before tightening its file mode", () => {
    const root = mkdtempSync(join(tmpdir(), "subkit-demo-hardlink-"));
    try {
      const instance = resolveCockpitDemoInstance({}, root);
      mkdirSync(instance.stateDir, { recursive: true });
      const target = join(root, "outside.json");
      writeFileSync(target, JSON.stringify(cockpitDemoMarker(instance, "sha256:image", "source")));
      chmodSync(target, 0o644);
      const mode = statSync(target).mode & 0o777;
      linkSync(target, join(instance.stateDir, "instance.json"));

      expect(() => readCockpitDemoMarker(instance)).toThrow("regular file");
      expect(statSync(target).mode & 0o777).toBe(mode);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("requires a matching marker only for destructive lifecycle actions", () => {
    const instance = resolveCockpitDemoInstance({}, "/repo");

    expect(() => assertCockpitDemoActionMarker(new Set(["--reset"]), null, instance)).toThrow(
      "missing or invalid",
    );
    expect(() => assertCockpitDemoActionMarker(new Set(["--stop"]), null, instance)).toThrow(
      "missing or invalid",
    );
    expect(() => assertCockpitDemoActionMarker(new Set(), null, instance)).not.toThrow();
  });
});
