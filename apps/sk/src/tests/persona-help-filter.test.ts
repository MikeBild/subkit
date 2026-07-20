// `sk --help` command-list filtering.
//
// Regression: `persona_hint` was only ever written for portal-token logins,
// so every profile from a normal `sk login` carried `null` — and the filter
// resolved that to the "user" tier (level 1), hiding every command above it.
// A tenant admin with a `*`-scoped key ran `sk --help` and saw no
// `sk agent`, no `sk knowledge-sources`, no `sk skills`, no `sk learnings`:
// the whole coding-agent + authoring surface was undiscoverable from the one
// command users explore with, and the docs pointed at commands the CLI hid.
//
// Two halves are pinned here:
//   1. an unknown/unset persona fails OPEN (help is UX-only; the engine
//      permission-checks every call regardless, so hiding is the only
//      failure mode with a real cost),
//   2. `personaHintForRole` maps engine role names to the cacheable persona
//      and refuses anything else, so `sk login` never persists a bogus tier.

// Deliberately imports ONLY persona-probe.ts: importing `../index.ts` (the
// CLI entry) from a test loads every command module ahead of the
// `mock.module()` calls that the `commands/*.test.ts` suites install first,
// which poisoned the shared worker's module cache and broke ~30 unrelated
// tests in the full run while every suite stayed green in isolation.
import { describe, expect, it } from "bun:test";
import { personaCanSee, personaHintForRole } from "../persona-probe.ts";

// The commands a Claude Code user needs; hiding these was the bug.
const AGENT_SURFACE = ["skill:read", "knowledge:read"] as const;

describe("personaCanSee — unknown persona fails open", () => {
  it("shows the agent/authoring surface when persona_hint is unset (every normal login)", () => {
    for (const requires of AGENT_SURFACE) {
      expect(personaCanSee(null, requires)).toBe(true);
      expect(personaCanSee(undefined, requires)).toBe(true);
    }
  });

  it("shows the agent/authoring surface for a custom RBAC role", () => {
    // A tenant role like "content-editor" maps to no built-in tier. The
    // engine still gates the call; the help must not pre-hide it.
    for (const requires of AGENT_SURFACE) {
      expect(personaCanSee("content-editor", requires)).toBe(true);
    }
  });

  it("still shows unrestricted commands to everyone", () => {
    expect(personaCanSee(null, undefined)).toBe(true);
    expect(personaCanSee("enduser", undefined)).toBe(true);
  });
});

describe("personaCanSee — known personas stay tailored", () => {
  it("admin sees the admin tier", () => {
    expect(personaCanSee("admin", "audit:read")).toBe(true);
    expect(personaCanSee("admin", "knowledge:read")).toBe(true);
  });

  it("member sees its own tier but not the operator/admin tiers", () => {
    expect(personaCanSee("member", "skill:read")).toBe(true);
    expect(personaCanSee("member", "knowledge:read")).toBe(true);
    expect(personaCanSee("member", "workflow:read")).toBe(false);
    expect(personaCanSee("member", "audit:read")).toBe(false);
  });

  it("portal/enduser stay narrowed to tier 1", () => {
    for (const persona of ["portal", "enduser"]) {
      expect(personaCanSee(persona, "conversation:write")).toBe(true);
      expect(personaCanSee(persona, "skill:read")).toBe(false);
      expect(personaCanSee(persona, "audit:read")).toBe(false);
    }
  });
});

describe("personaHintForRole — what sk login may cache", () => {
  it("maps the built-in engine roles", () => {
    expect(personaHintForRole("admin")).toBe("admin");
    expect(personaHintForRole("operator")).toBe("operator");
    expect(personaHintForRole("member")).toBe("member");
    expect(personaHintForRole("enduser")).toBe("enduser");
    expect(personaHintForRole("portal")).toBe("portal");
  });

  it("is case-insensitive (role names are engine-supplied)", () => {
    expect(personaHintForRole("Admin")).toBe("admin");
    expect(personaHintForRole("MEMBER")).toBe("member");
  });

  it("refuses custom roles, the `user` placeholder, and empty input", () => {
    // `user` is the unset default in PERSONA_LEVEL, not a real engine role —
    // caching it would pin the profile to tier 1, re-creating the bug.
    for (const role of ["content-editor", "user", "", null, undefined]) {
      expect(personaHintForRole(role)).toBeNull();
    }
  });

  it("every cacheable persona is one the filter actually knows", () => {
    // Guards the seam between login (writes the hint) and help (reads it):
    // a persona login can cache must never fail open by accident.
    for (const role of ["admin", "operator", "member", "enduser", "portal"]) {
      const persona = personaHintForRole(role);
      expect(persona).not.toBeNull();
      // A known persona is tailored, so at least one high tier is denied
      // for the low personas and allowed for admin — i.e. not fail-open.
      expect(personaCanSee(persona, "audit:read")).toBe(role === "admin");
    }
  });
});
