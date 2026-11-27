import { describe, expect, test } from "bun:test";
import { rewriteRetiredProbePath } from "./probe-path.ts";

const probe = (path: string) => ({ method: "GET", path, expected_status: [200, 200] });

describe("rewriteRetiredProbePath", () => {
  test("moves a jira connector from the retired path to /myself and keeps the rest", () => {
    const config = { probe_endpoint: probe("/rest/api/3/myself"), timeout_ms: 5000 };
    expect(rewriteRetiredProbePath("jira", config)).toEqual({
      changed: true,
      config: { probe_endpoint: probe("/myself"), timeout_ms: 5000 },
    });
  });

  test("moves a salesforce connector from /services/data to /sobjects", () => {
    expect(
      rewriteRetiredProbePath("salesforce", { probe_endpoint: probe("/services/data") }),
    ).toEqual({ changed: true, config: { probe_endpoint: probe("/sobjects") } });
  });

  test("leaves an already moved or hand-chosen path alone", () => {
    expect(rewriteRetiredProbePath("jira", { probe_endpoint: probe("/myself") })).toEqual({
      changed: false,
    });
    expect(
      rewriteRetiredProbePath("jira", { probe_endpoint: probe("/rest/api/3/serverInfo") }),
    ).toEqual({
      changed: false,
    });
    expect(
      rewriteRetiredProbePath("salesforce", { probe_endpoint: probe("/services/data/v67.0") }),
    ).toEqual({ changed: false });
  });

  test("touches only the template that owned the retired path", () => {
    expect(
      rewriteRetiredProbePath("salesforce", { probe_endpoint: probe("/rest/api/3/myself") }),
    ).toEqual({ changed: false });
    expect(rewriteRetiredProbePath(null, { probe_endpoint: probe("/services/data") })).toEqual({
      changed: false,
    });
    expect(rewriteRetiredProbePath("github", { probe_endpoint: probe("/services/data") })).toEqual({
      changed: false,
    });
  });

  test("ignores a connector without a probe or with an unreadable config", () => {
    expect(rewriteRetiredProbePath("jira", {})).toEqual({ changed: false });
    expect(rewriteRetiredProbePath("jira", { probe_endpoint: null })).toEqual({ changed: false });
    expect(rewriteRetiredProbePath("jira", null)).toEqual({ changed: false });
    expect(rewriteRetiredProbePath("jira", [])).toEqual({ changed: false });
  });

  test("running it twice changes nothing more", () => {
    const first = rewriteRetiredProbePath("jira", { probe_endpoint: probe("/rest/api/3/myself") });
    if (!first.changed) throw new Error("expected a rewrite");
    expect(rewriteRetiredProbePath("jira", first.config)).toEqual({ changed: false });
  });

  test("only plain objects count as a config or a probe", () => {
    const retired = probe("/rest/api/3/myself");
    const callable = Object.assign(() => undefined, { probe_endpoint: retired });
    expect(rewriteRetiredProbePath("jira", callable)).toEqual({ changed: false });
    const listed = Object.assign([], { probe_endpoint: retired });
    expect(rewriteRetiredProbePath("jira", listed)).toEqual({ changed: false });
    const callableProbe = Object.assign(() => undefined, { path: "/rest/api/3/myself" });
    expect(rewriteRetiredProbePath("jira", { probe_endpoint: callableProbe })).toEqual({
      changed: false,
    });
    const listedProbe = Object.assign([], { path: "/rest/api/3/myself" });
    expect(rewriteRetiredProbePath("jira", { probe_endpoint: listedProbe })).toEqual({
      changed: false,
    });
    expect(rewriteRetiredProbePath("jira", "text")).toEqual({ changed: false });
    expect(rewriteRetiredProbePath("jira", { probe_endpoint: "text" })).toEqual({ changed: false });
  });
});
