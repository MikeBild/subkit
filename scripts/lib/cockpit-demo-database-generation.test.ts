import { describe, expect, test } from "bun:test";
import { cockpitDemoDatabaseGeneration } from "./cockpit-demo-database-generation.mjs";

const instance = { project: "subkit-cockpit-demo" };
const containerId = "a".repeat(64);

describe("selected Cockpit demo database identity", () => {
  test("binds the exact Compose postgres container and mounted database volume", () => {
    const calls: string[][] = [];
    const run = (_command: string, args: string[]) => {
      calls.push(args);
      return calls.length === 1
        ? { status: 0, stdout: `${containerId}\n` }
        : {
            status: 0,
            stdout: `${containerId}|volume:subkit-cockpit-demo_demo-postgres:/var/lib/docker/volumes/demo:/var/lib/postgresql\n`,
          };
    };
    const generation = cockpitDemoDatabaseGeneration(instance, "/repo", run as never);
    expect(generation).toMatch(/^[0-9a-f]{64}$/);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("subkit-cockpit-demo");
    expect(calls[1]).toContain(containerId);
    expect(calls[1][2]).toContain("{{.Id}}|{{range .Mounts}}{{.Type}}:");
  });

  test("fails closed when the selected container or volume cannot be verified", () => {
    expect(() =>
      cockpitDemoDatabaseGeneration(instance, "/repo", (() => ({
        status: 1,
        stdout: "",
      })) as never),
    ).toThrow("container identity");
    expect(() =>
      cockpitDemoDatabaseGeneration(instance, "/repo", ((_, args) =>
        args[0] === "inspect"
          ? { status: 0, stdout: `${containerId}|` }
          : { status: 0, stdout: `${containerId}\n` }) as never),
    ).toThrow("volume identity");
  });
});
