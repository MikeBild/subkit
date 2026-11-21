import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { LOCAL_PORT_ENV, LOCAL_READY_EVENT } from "@shared/device/local-launch.ts";
import { isLoopbackPeer } from "../http/routes/identity/local-session.ts";
import { createPowerState } from "../scheduler/power-state.ts";
import { assertSelfUpdateAllowed } from "../self-update.ts";
import {
  chooseLocalPort,
  completeLocalLaunch,
  type LocalWorkspace,
  launchSecretMatches,
  localHostAllowed,
  localWorkspaceFor,
  parseLocalLaunchLine,
  readLaunchLine,
  unavailableLocally,
  watchLauncherExit,
} from "./local-workspace.ts";

const SECRET = "A".repeat(43);

describe("local workspace", () => {
  test("server mode has no local workspace; local mode keeps the workspace port", () => {
    expect(localWorkspaceFor("server", { [LOCAL_PORT_ENV]: "41000" })).toBeNull();
    expect(localWorkspaceFor("local_workspace", {})).toMatchObject({
      preferredPort: null,
      port: null,
      launchSecret: null,
    });
    expect(localWorkspaceFor("local_workspace", {})?.power.deferred()).toBe(false);
    expect(localWorkspaceFor("local_workspace", { [LOCAL_PORT_ENV]: "41000" })?.preferredPort).toBe(
      41_000,
    );
    expect(() => localWorkspaceFor("local_workspace", { [LOCAL_PORT_ENV]: "80" })).toThrow(
      /not a port/,
    );
  });

  test("self-update and rollback are off in local mode only", async () => {
    await expect(assertSelfUpdateAllowed("local_workspace")).rejects.toThrow(
      /self-update is off in local mode/,
    );
    await expect(assertSelfUpdateAllowed("server")).resolves.toBeUndefined();
  });
});

describe("port", () => {
  test("keeps the remembered port when it is free", async () => {
    const asked: number[] = [];
    const choice = await chooseLocalPort(41_000, async (port) => {
      asked.push(port);
      return port;
    });
    expect(choice).toEqual({ port: 41_000, reassigned: false });
    expect(asked).toEqual([41_000]);
  });

  test("takes a fresh port and says so when the remembered one is taken", async () => {
    const choice = await chooseLocalPort(41_000, async (port) => (port === 0 ? 52_123 : null));
    expect(choice).toEqual({ port: 52_123, reassigned: true });
  });

  test("a first start takes a fresh port without calling it reassigned", async () => {
    expect(await chooseLocalPort(null, async () => 52_124)).toEqual({
      port: 52_124,
      reassigned: false,
    });
    await expect(chooseLocalPort(null, async () => null)).rejects.toThrow(/no free loopback port/);
  });

  test("a real probe finds a free loopback port", async () => {
    const choice = await chooseLocalPort(null);
    expect(choice.port).toBeGreaterThan(0);
  });
});

describe("launch handshake", () => {
  test("parses only the launch secret", () => {
    expect(parseLocalLaunchLine(JSON.stringify({ launch_secret: SECRET }))).toEqual({
      launch_secret: SECRET,
    });
    for (const launch of [{ launch_secret: "short" }, { launch_secret: SECRET, port: 4 }, {}])
      expect(() => parseLocalLaunchLine(JSON.stringify(launch))).toThrow();
    expect(() => parseLocalLaunchLine("launch")).toThrow(/not JSON/);
  });

  test("reads the first line and leaves the stream open", async () => {
    const stream = new PassThrough();
    const line = readLaunchLine(stream, 5_000);
    stream.write('{"launch_secret":');
    stream.write(`"${SECRET}"}\nrest`);
    expect(await line).toBe(`{"launch_secret":"${SECRET}"}`);
    expect(stream.listenerCount("data")).toBe(0);
    expect(stream.destroyed).toBe(false);
  });

  test("fails when stdin closes, overflows or stays silent", async () => {
    const closed = new PassThrough();
    const early = readLaunchLine(closed, 5_000);
    closed.end("partial");
    await expect(early).rejects.toThrow(/closed/);
    const flooded = new PassThrough();
    const overflow = readLaunchLine(flooded, 5_000);
    flooded.write("x".repeat(5_000));
    await expect(overflow).rejects.toThrow(/too long/);
    await expect(readLaunchLine(new PassThrough(), 1)).rejects.toThrow(/within 1 ms/);
  });

  test("reports the bound port first and takes the secret only afterwards", async () => {
    const workspace: LocalWorkspace = {
      preferredPort: 41_000,
      port: null,
      launchSecret: null,
      power: createPowerState(),
    };
    const written: string[] = [];
    const input = new PassThrough();
    const done = completeLocalLaunch(
      workspace,
      { port: 52_000, reassigned: true },
      { out: { write: (chunk: string) => written.push(chunk) }, input },
      5_000,
    );
    expect(workspace.port).toBe(52_000);
    expect(workspace.launchSecret).toBeNull();
    expect(JSON.parse(written[0] ?? "")).toEqual({
      event: LOCAL_READY_EVENT,
      port: 52_000,
      reassigned: true,
    });
    input.write(`${JSON.stringify({ launch_secret: SECRET })}\n`);
    await done;
    expect(workspace.launchSecret).toBe(SECRET);
  });

  test("the launcher going away is reported", async () => {
    const stream = new PassThrough();
    let gone = 0;
    watchLauncherExit(stream, () => {
      gone += 1;
    });
    stream.end();
    await new Promise<void>((resolve) => stream.once("close", () => resolve()));
    expect(gone).toBeGreaterThanOrEqual(1);
  });
});

describe("request checks", () => {
  test("the launch secret matches only exactly and never before the launch", () => {
    expect(launchSecretMatches(SECRET, SECRET)).toBe(true);
    expect(launchSecretMatches(SECRET, `${SECRET}A`)).toBe(false);
    expect(launchSecretMatches(SECRET, "")).toBe(false);
    expect(launchSecretMatches(SECRET, undefined)).toBe(false);
    expect(launchSecretMatches(null, SECRET)).toBe(false);
  });

  test("only the loopback address with the reported port is a valid host", () => {
    expect(localHostAllowed("127.0.0.1:40000", 40_000)).toBe(true);
    expect(localHostAllowed("127.0.0.1:40001", 40_000)).toBe(false);
    expect(localHostAllowed("localhost:40000", 40_000)).toBe(false);
    expect(localHostAllowed("127.0.0.1", 40_000)).toBe(false);
    expect(localHostAllowed(undefined, 40_000)).toBe(false);
    expect(localHostAllowed("127.0.0.1:40000", null)).toBe(false);
  });

  test("loopback peers are recognized, others are not", () => {
    expect(isLoopbackPeer("127.0.0.1")).toBe(true);
    expect(isLoopbackPeer("::1")).toBe(true);
    expect(isLoopbackPeer("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackPeer("192.168.1.2")).toBe(false);
    expect(isLoopbackPeer("::ffff:10.0.0.1")).toBe(false);
    expect(isLoopbackPeer(undefined)).toBe(false);
  });

  test("names what a local workspace cannot offer", () => {
    expect(unavailableLocally("POST", "/v1/webhooks/inbound")).toBe("inbound_hooks");
    expect(unavailableLocally("GET", "/v1/webhooks/inbound")).toBeNull();
    expect(unavailableLocally("POST", "/v1/identity/portal-tokens")).toBe("portal_tokens");
    expect(unavailableLocally("PUT", "/v1/cockpit/push-subscription")).toBe("push");
    expect(unavailableLocally("POST", "/v1/workflows")).toBeNull();
  });
});
