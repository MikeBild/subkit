import { expect, test } from "bun:test";
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
