import Big from "big.js";
import { text } from "./limits.ts";

type Rounding = "down" | "halfUp" | "halfEven" | "up";
const modes = { down: 0, halfUp: 1, halfEven: 2, up: 3 } as const;
function decimal(value: string): Big {
  if (!/^-?\d+(?:\.\d+)?$/.test(text(value)) || value.length > 1024)
    throw new Error("Money requires decimal strings");
  return new Big(value);
}
function options(scale: number, rounding: Rounding): void {
  if (!Number.isInteger(scale) || scale < 0 || scale > 100 || !Object.hasOwn(modes, rounding))
    throw new Error("Explicit scale and rounding required");
}
export const money = Object.freeze({
  add: (a: string, b: string) => decimal(a).plus(decimal(b)).toFixed(),
  sub: (a: string, b: string) => decimal(a).minus(decimal(b)).toFixed(),
  mul: (a: string, b: string) => decimal(a).times(decimal(b)).toFixed(),
  compare: (a: string, b: string) => decimal(a).cmp(decimal(b)),
  round(a: string, scale: number, rounding: Rounding) {
    options(scale, rounding);
    return decimal(a).toFixed(scale, modes[rounding]);
  },
  div(a: string, b: string, scale: number, rounding: Rounding) {
    options(scale, rounding);
    const Decimal = Big();
    Decimal.DP = scale;
    Decimal.RM = modes[rounding];
    return new Decimal(decimal(a)).div(decimal(b)).toFixed(scale);
  },
});
