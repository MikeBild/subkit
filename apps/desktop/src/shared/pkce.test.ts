import { describe, expect, test } from "bun:test";
import { challengeFor, createPkcePair, createState, sameState } from "./pkce.ts";

describe("pkce", () => {
  test("derives the RFC 7636 appendix B challenge", () => {
    expect(challengeFor("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  test("builds a URL-safe verifier of 43 characters from 32 bytes", () => {
    const pair = createPkcePair(new Uint8Array(32).fill(251));
    expect(pair.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pair.challenge).toBe(challengeFor(pair.verifier));
    expect(pair.method).toBe("S256");
  });

  test("refuses weak entropy", () => {
    expect(() => createPkcePair(new Uint8Array(16))).toThrow();
    expect(() => createState(new Uint8Array(8))).toThrow();
  });

  test("creates different pairs and states by default", () => {
    expect(createPkcePair().verifier).not.toBe(createPkcePair().verifier);
    expect(createState()).not.toBe(createState());
  });

  test("compares states exactly", () => {
    const state = createState(new Uint8Array(24).fill(3));
    expect(sameState(state, state)).toBe(true);
    expect(sameState(state, `${state}x`)).toBe(false);
    expect(sameState(state, state.toLowerCase())).toBe(false);
    expect(sameState("", "")).toBe(false);
  });
});
