import { describe, expect, it } from "bun:test";
import { personaCanSee, personaHintForRole } from "../persona-probe.ts";

const AGENT_SURFACE = ["skill:read", "knowledge:read"] as const;

describe("personaCanSee — unknown persona fails open", () => {
  it("shows the agent/authoring surface when persona_hint is unset (every normal login)", () => {
    for (const requires of AGENT_SURFACE) {
      expect(personaCanSee(null, requires)).toBe(true);
      expect(personaCanSee(undefined, requires)).toBe(true);
    }
  });

  it("shows the agent/authoring surface for a custom RBAC role", () => {
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
    for (const role of ["content-editor", "user", "", null, undefined]) {
      expect(personaHintForRole(role)).toBeNull();
    }
  });

  it("every cacheable persona is one the filter actually knows", () => {
    for (const role of ["admin", "operator", "member", "enduser", "portal"]) {
      const persona = personaHintForRole(role);
      expect(persona).not.toBeNull();
      expect(personaCanSee(persona, "audit:read")).toBe(role === "admin");
    }
  });
});
