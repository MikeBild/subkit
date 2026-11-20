import { describe, expect, test } from "bun:test";
import { findDeepLink, parseDeepLink, secondInstanceAction } from "./deep-link.ts";

describe("parseDeepLink", () => {
  test("reads code and state from the callback", () => {
    expect(parseDeepLink("subkit://callback?code=abcDEF12-_.~&state=stateSTATE99")).toEqual({
      kind: "callback",
      code: "abcDEF12-_.~",
      state: "stateSTATE99",
    });
    expect(parseDeepLink("subkit://callback/?code=abcdefgh&state=ijklmnop")?.kind).toBe("callback");
  });

  test("reads a cancelled login", () => {
    expect(parseDeepLink("subkit://callback?error=access_denied&state=ijklmnop")).toEqual({
      kind: "callback-error",
      error: "access_denied",
      state: "ijklmnop",
    });
    expect(parseDeepLink("subkit://callback?error=access_denied")).toEqual({
      kind: "callback-error",
      error: "access_denied",
      state: null,
    });
  });

  test("accepts the bare open link", () => {
    expect(parseDeepLink("subkit://open")).toEqual({ kind: "open" });
  });

  test("rejects other schemes, hosts, paths and malformed parameters", () => {
    for (const raw of [
      "https://callback?code=abcdefgh&state=ijklmnop",
      "subkit://evil?code=abcdefgh&state=ijklmnop",
      "subkit://callback/extra?code=abcdefgh&state=ijklmnop",
      "subkit://user@callback?code=abcdefgh&state=ijklmnop",
      "subkit://callback?code=abcdefgh",
      "subkit://callback?state=ijklmnop",
      "subkit://callback?code=short&state=ijklmnop",
      "subkit://callback?code=abc%20defgh&state=ijklmnop",
      "subkit://callback?code=abcdefgh&code=zzzzzzzz&state=ijklmnop",
      "subkit://callback?error=<script>&state=ijklmnop",
      "subkit://open/anything",
      "not a url",
      "",
    ]) {
      expect(parseDeepLink(raw)).toBeNull();
    }
  });
});

describe("findDeepLink", () => {
  test("picks the last subkit link from the arguments of a second instance", () => {
    expect(
      findDeepLink([
        "C:\\SubKit.exe",
        "--flag",
        "subkit://open",
        "SUBKIT://callback?code=a&state=b",
      ]),
    ).toBe("SUBKIT://callback?code=a&state=b");
    expect(findDeepLink(["/usr/bin/subkit", "--hidden"])).toBeNull();
  });

  test("a build only reads links of its own scheme", () => {
    const dev = "subkit-dev://callback?code=abcdefgh&state=ijklmnop";
    const argv = ["/opt/SubKit/subkit-desktop", "subkit://open", dev];
    expect(findDeepLink(argv, "subkit-dev")).toBe(dev);
    expect(findDeepLink(argv)).toBe("subkit://open");
    expect(findDeepLink(["app", "subkit-development://open"], "subkit-dev")).toBeNull();
    expect(parseDeepLink(dev, "subkit-dev")?.kind).toBe("callback");
    expect(parseDeepLink(dev)).toBeNull();
    expect(parseDeepLink("subkit://open", "subkit-dev")).toBeNull();
  });

  test("ignores switches, file paths and links hidden inside other arguments", () => {
    for (const argv of [
      ["SubKit.exe", "--allow-file-access-from-files", "--original-process-start-time=1"],
      ["SubKit.exe", "C:\\Users\\me\\subkit://open"],
      ["SubKit.exe", "--url=subkit://open"],
      ["SubKit.exe", " subkit://open"],
      [],
    ])
      expect(findDeepLink(argv)).toBeNull();
  });

  test("reads the link Windows and Linux append to the arguments of a second instance", () => {
    expect(
      findDeepLink([
        "C:\\Users\\me\\AppData\\Local\\Programs\\SubKit\\SubKit.exe",
        "--allow-file-access-from-files",
        "subkit://callback/?code=abcdefgh&state=ijklmnop",
      ]),
    ).toBe("subkit://callback/?code=abcdefgh&state=ijklmnop");
    expect(
      parseDeepLink(
        findDeepLink([
          "/opt/SubKit/subkit-desktop",
          "subkit://callback/?code=abcdefgh&state=ijklmnop",
        ]) ?? "",
      ),
    ).toEqual({ kind: "callback", code: "abcdefgh", state: "ijklmnop" });
  });
});

describe("secondInstanceAction", () => {
  test("a second start with a link hands the link over", () => {
    expect(
      secondInstanceAction(["SubKit.exe", "subkit://callback?code=abcdefgh&state=ijklmnop"]),
    ).toEqual({ kind: "link", link: "subkit://callback?code=abcdefgh&state=ijklmnop" });
  });

  test("a plain second start opens the window, a hidden autostart does nothing", () => {
    expect(secondInstanceAction(["SubKit.exe"])).toEqual({ kind: "open" });
    expect(secondInstanceAction(["SubKit.exe", "--hidden"])).toEqual({ kind: "none" });
    expect(
      secondInstanceAction(["/opt/SubKit/subkit-desktop", "--hidden", "subkit://open"]),
    ).toEqual({ kind: "link", link: "subkit://open" });
  });

  test("a link of the other channel is not handed over", () => {
    expect(secondInstanceAction(["SubKit.exe", "subkit-dev://open"])).toEqual({ kind: "open" });
    expect(secondInstanceAction(["SubKit Dev.exe", "subkit-dev://open"], "subkit-dev")).toEqual({
      kind: "link",
      link: "subkit-dev://open",
    });
  });
});
