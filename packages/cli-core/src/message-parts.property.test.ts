import { expect, test } from "bun:test";
import fc from "fast-check";
import { parseRenderableMessageContent } from "./message-parts.ts";

test("parseRenderableMessageContent is total and does not mutate JSON-shaped input", () => {
  fc.assert(
    fc.property(fc.jsonValue(), (content) => {
      const before = structuredClone(content);
      const parsed = parseRenderableMessageContent(content);
      expect(content).toEqual(before);
      expect(typeof parsed.text).toBe("string");
      for (const part of parsed.parts) {
        expect(["text", "code_block", "table"]).toContain(part.type);
      }
    }),
    { seed: 20_261_109, numRuns: 200 },
  );
});
