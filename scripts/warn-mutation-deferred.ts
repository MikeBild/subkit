import { execFileSync } from "node:child_process";
import { mutationDeferralWarning } from "./lib/mutation-deferral.ts";

const head = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
console.error(mutationDeferralWarning(`commit ${head}`));
