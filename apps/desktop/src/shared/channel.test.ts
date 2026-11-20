import { describe, expect, test } from "bun:test";
import { CHANNELS, loginCallback, protocolRegistration, resolveChannel } from "./channel.ts";

describe("resolveChannel", () => {
  test("only a packaged production build is the production channel", () => {
    expect(resolveChannel("production", true)).toBe(CHANNELS.production);
    expect(resolveChannel("production", false)).toBe(CHANNELS.development);
    expect(resolveChannel("development", true)).toBe(CHANNELS.development);
    expect(resolveChannel(undefined, true)).toBe(CHANNELS.development);
    expect(resolveChannel("PRODUCTION", true)).toBe(CHANNELS.development);
  });

  test("the channels never share a bundle id, a scheme, a name or an autostart file", () => {
    const { production, development } = CHANNELS;
    for (const key of ["name", "appId", "scheme", "autostartFile"] as const)
      expect(production[key]).not.toBe(development[key]);
    expect(loginCallback(production.scheme)).toBe("subkit://callback");
    expect(loginCallback(development.scheme)).toBe("subkit-dev://callback");
    expect(development.scheme.startsWith(`${production.scheme}:`)).toBe(false);
  });
});

describe("protocolRegistration", () => {
  test("a packaged app registers itself", () => {
    expect(
      protocolRegistration({
        scheme: "subkit",
        defaultApp: false,
        execPath: "C:\\Program Files\\SubKit\\SubKit.exe",
        argv: ["C:\\Program Files\\SubKit\\SubKit.exe", "--hidden"],
      }),
    ).toEqual({ scheme: "subkit", executable: null, args: [] });
  });

  test("a development run registers the runtime together with the app folder", () => {
    expect(
      protocolRegistration({
        scheme: "subkit-dev",
        defaultApp: true,
        execPath: "/repo/node_modules/electron/dist/electron",
        argv: ["/repo/node_modules/electron/dist/electron", "/repo/apps/desktop"],
      }),
    ).toEqual({
      scheme: "subkit-dev",
      executable: "/repo/node_modules/electron/dist/electron",
      args: ["/repo/apps/desktop"],
    });
    expect(
      protocolRegistration({
        scheme: "subkit-dev",
        defaultApp: true,
        execPath: "/electron",
        argv: ["/electron"],
      }),
    ).toEqual({ scheme: "subkit-dev", executable: null, args: [] });
  });
});
