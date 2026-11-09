import { expect, test } from "bun:test";
import { compile } from "./jsonata-contract.ts";

test("runtime determinism guards survive edits through JSONata's public AST interface", async () => {
  for (const name of ["random", "shuffle"]) {
    const expression = compile("$sum([1, 2])");
    expect(await expression.evaluate({})).toBe(3);
    const procedure = expression.ast().procedure;
    if (!procedure) throw new Error("expected a function-call AST");
    procedure.value = name;
    await expect(expression.evaluate({})).rejects.toThrow(
      `JSONata ${name} is not available in deterministic execution`,
    );
    expect(await compile("$sum([1, 2])").evaluate({})).toBe(3);
  }
});
