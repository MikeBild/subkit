import { expect, test } from "bun:test";
import { createDockerHarnessRunLifecycle } from "./_harness.ts";
import type { DockerTestRun } from "./_run.ts";

const run: DockerTestRun = {
  runId: "run",
  project: "project",
  image: "image",
  apiPort: "0",
  dbPort: "0",
  baseUrl: "http://127.0.0.1:0",
  owned: true,
};

test("a failed fresh build retains its run identity without retrying the build", () => {
  const failure = new Error("fresh Docker build failed (1)");
  let builds = 0;
  const lifecycle = createDockerHarnessRunLifecycle(
    () => run,
    () => {
      builds += 1;
      throw failure;
    },
  );

  expect(() => lifecycle.run()).toThrow(failure);
  expect(lifecycle.existingRun()).toBe(run);
  expect(() => lifecycle.run()).toThrow(failure);
  expect(builds).toBe(1);
});

test("observing an unused lifecycle never starts a build, and successful builds are reused", () => {
  let builds = 0;
  const built = { ...run, image: "built" };
  const lifecycle = createDockerHarnessRunLifecycle(
    () => run,
    () => {
      builds += 1;
      return built;
    },
  );
  expect(lifecycle.existingRun()).toBeUndefined();
  expect(builds).toBe(0);
  expect(lifecycle.run()).toBe(built);
  expect(lifecycle.run()).toBe(built);
  expect(builds).toBe(1);
});

test("falsy thrown failures cannot expose an unbuilt run on retry", () => {
  for (const error of [null, undefined, false, 0, ""]) {
    let builds = 0;
    const lifecycle = createDockerHarnessRunLifecycle(
      () => run,
      () => {
        builds += 1;
        throw error;
      },
    );
    for (let attempt = 0; attempt < 2; attempt++) {
      let thrown = false;
      try {
        lifecycle.run();
      } catch (actual) {
        thrown = true;
        expect(actual).toBe(error);
      }
      expect(thrown).toBe(true);
    }
    expect(lifecycle.existingRun()).toBe(run);
    expect(builds).toBe(1);
  }
});
