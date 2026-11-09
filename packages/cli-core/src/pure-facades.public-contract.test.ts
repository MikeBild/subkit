import { expect, test } from "bun:test";
import * as errors from "./errors.ts";
import * as classification from "./errors-classification.ts";
import * as format from "./format.ts";
import * as render from "./format-render.ts";

test("existing CLI error exports keep their class and classification contract", () => {
  expect(errors.isEngineError).toBe(classification.isEngineError);
  expect(errors.isTransportError).toBe(classification.isTransportError);
  expect(errors.formatError).toBe(classification.formatError);
  expect(errors.exitCodeFor).toBe(classification.exitCodeFor);
  expect(errors.engineErrorDetailLines).toBe(classification.engineErrorDetailLines);
  const engine = new errors.EngineError(409, {
    code: "conflict",
    message: "Changed",
    trace_id: "trace",
  });
  expect(errors.isEngineError(engine)).toBe(true);
  expect(errors.formatError(engine)).toBe("conflict: Changed [trace=trace]");
  expect(errors.exitCodeFor(engine)).toBe(1);
  const transport = new errors.TransportError(new Error("offline"));
  expect(errors.isTransportError(transport)).toBe(true);
  expect(errors.exitCodeFor(transport)).toBe(2);
});

test("existing CLI rendering exports preserve the pure renderers", () => {
  expect(format.toJson).toBe(render.toJson);
  expect(format.renderTable).toBe(render.renderTable);
});
