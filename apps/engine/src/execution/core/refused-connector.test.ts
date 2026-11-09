import { expect, test } from "bun:test";
import fc from "fast-check";
import { refusedConnector } from "./outcome.ts";

test("refusal facts reject missing reason and normalize connector IDs", () => {
  for (const value of [
    undefined,
    null,
    {},
    { connector: null },
    { connector: {} },
    { connector: { reason: 4 } },
  ])
    expect(refusedConnector(value)).toBeNull();
  for (const connector_id of [undefined, null, false, 1, {}])
    expect(refusedConnector({ connector: { connector_id, reason: "disabled" } })).toEqual({
      connector_id: null,
      reason: "disabled",
    });
});

test("refusal projections preserve exact text and never retain the input record", () => {
  fc.assert(
    fc.property(fc.string(), fc.string(), (connector_id, reason) => {
      const connector = Object.freeze({ connector_id, reason });
      const result = refusedConnector(Object.freeze({ connector }));
      expect(result).toEqual(connector);
      expect(result).not.toBe(connector);
    }),
    { seed: 20261109, numRuns: 100 },
  );
});
