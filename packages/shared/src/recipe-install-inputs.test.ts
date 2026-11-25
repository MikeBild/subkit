import { describe, expect, test } from "bun:test";
import { pinInstallInputs, pinnableInstallInput } from "./recipe-install-inputs.ts";

test("pins a mailbox and a numeric path input together (#590)", () => {
  const definition = {
    steps: [
      {
        kind: "request",
        path: `/properties/\${input.property_id}`,
        transactional_delivery: { from: "sender@install-input.invalid" },
      },
    ],
  };
  expect(pinnableInstallInput(42)).toBe("42");
  expect(
    pinInstallInputs(definition, ["sender", "property_id"], {
      sender: "team@example.com",
      property_id: 42,
    }),
  ).toEqual({
    ok: true,
    definition: {
      steps: [
        {
          kind: "request",
          path: "/properties/42",
          transactional_delivery: { from: "team@example.com" },
        },
      ],
    },
  });
});

describe("host-list install inputs (#895)", () => {
  const definition = {
    steps: [
      {
        kind: "request",
        url: `\${input.url}`,
        boundary: { allowed_hosts: `\${input.allowed_hosts}`, max_bytes: 1024 },
      },
    ],
  };

  test("pins a host list into the request boundary without mutating the recipe", () => {
    const hosts = ["docs.example.com", "example.com"];
    expect(pinInstallInputs(definition, ["allowed_hosts"], { allowed_hosts: hosts })).toEqual({
      ok: true,
      definition: {
        steps: [
          {
            kind: "request",
            url: `\${input.url}`,
            boundary: { allowed_hosts: hosts, max_bytes: 1024 },
          },
        ],
      },
    });
    expect(definition.steps[0]?.boundary.allowed_hosts).toBe(`\${input.allowed_hosts}`);
  });

  test("host lists only pin an exact boundary placeholder of a declared input", () => {
    const original = {
      steps: [
        {
          kind: "request",
          url: `https://\${input.allowed_hosts}/`,
          boundary: { allowed_hosts: ["fixed.example.com"] },
        },
        { kind: "request", boundary: { allowed_hosts: `prefix-\${input.allowed_hosts}` } },
        { kind: "transform", boundary: { allowed_hosts: `\${input.allowed_hosts}` } },
      ],
    };
    const inputs = { allowed_hosts: ["docs.example.com"] };
    expect(pinInstallInputs(original, ["allowed_hosts"], inputs)).toMatchObject({
      ok: false,
      key: "allowed_hosts",
    });
    expect(pinInstallInputs(definition, [], inputs)).toEqual({ ok: true, definition });
  });

  test("rejects empty lists and values that are not literal DNS hosts", () => {
    for (const allowed_hosts of [
      [],
      [42],
      [""],
      ["https://example.com"],
      ["*.example.com"],
      ["example.com:8443"],
      ["10.0.0.1"],
      [`\${input.host}`],
      ["-bad.example.com"],
    ]) {
      expect(pinInstallInputs(definition, ["allowed_hosts"], { allowed_hosts })).toMatchObject({
        ok: false,
        key: "allowed_hosts",
      });
    }
  });
});
