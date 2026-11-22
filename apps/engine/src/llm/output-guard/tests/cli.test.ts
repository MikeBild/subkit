import { describe, expect, it } from "bun:test";
import { cliScanner } from "../scanners/cli.ts";

const ctx = { engine_url: "https://subkit-api.example.com" };

function bash(...lines: string[]): string {
  return ["```bash", ...lines, "```"].join("\n");
}

describe("cliScanner", () => {
  it("passes a clean apikeys create with the real flags", () => {
    const text = bash('subkit apikeys create --name "Codex MCP" --scopes "workflow:read"');
    expect(cliScanner.scan(text, ctx)).toEqual([]);
  });

  it("flags an invented flag (the original transcript bug)", () => {
    const text = bash('subkit apikeys create --name X --scoped "*"');
    const vs = cliScanner.scan(text, ctx);
    expect(vs.map((v) => v.kind)).toContain("cli.invented_flag");
    const v = vs[0]!;
    expect(v.details?.invented_flag).toBe("scoped");
  });

  it("suggests the nearest valid flag when the user mistyped", () => {
    const text = bash("subkit apikeys create --name X --expirs 2026-01-01");
    const vs = cliScanner.scan(text, ctx);
    expect(vs[0]?.details?.suggestion).toBe("expires");
  });

  it("flags an unknown subcommand", () => {
    const text = bash("subkit fubar create");
    const vs = cliScanner.scan(text, ctx);
    expect(vs.map((v) => v.kind)).toContain("cli.unknown_subcommand");
  });

  it("accepts the `subkit` alias", () => {
    const text = bash("subkit apikeys create --name Y");
    expect(cliScanner.scan(text, ctx)).toEqual([]);
  });

  it("ignores non-bash fenced blocks", () => {
    const text = '```json\n{ "subkit": "--foo" }\n```';
    expect(cliScanner.scan(text, ctx)).toEqual([]);
  });

  it("accepts global flags on any subcommand", () => {
    const text = bash("subkit apikeys create --name X --tenant my-tenant");
    expect(cliScanner.scan(text, ctx)).toEqual([]);
  });

  it("handles --key=value flag form", () => {
    const text = bash("subkit apikeys create --name=X --scopes=workflow:read");
    expect(cliScanner.scan(text, ctx)).toEqual([]);
  });

  it("skips multi-line continuations and pipes correctly", () => {
    const text = bash("subkit apikeys list --json | jq '.items[].id'");
    expect(cliScanner.scan(text, ctx)).toEqual([]);
  });

  it("passes the package export and import commands with their real flags", () => {
    const text = bash(
      "subkit packages export --out workspace.zip --only workflow,skill --profile api",
      "subkit packages import workspace.zip --profile cloud --yes",
      "subkit packages installs --json",
    );
    expect(cliScanner.scan(text, ctx)).toEqual([]);
  });

  it("flags an invented package subcommand flag", () => {
    const text = bash("subkit packages import workspace.zip --force");
    const vs = cliScanner.scan(text, ctx);
    expect(vs.map((v) => v.kind)).toContain("cli.invented_flag");
  });

  it("does not flag plain prose mentioning subkit", () => {
    expect(cliScanner.scan("subkit is a CLI", ctx)).toEqual([]);
  });
});
