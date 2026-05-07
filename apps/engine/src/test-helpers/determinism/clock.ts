// Test-helpers re-export over the production clock seam at
// `apps/engine/src/utils/clock.ts`. The actual override state lives
// there so production code never imports from `test-helpers/`. This
// barrel keeps the historical test imports working.

export {
  createDeterministicClock,
  type DeterministicClock,
  FROZEN_NOW,
  getNowProvider,
  getTestNow,
  installClock,
  type NowProvider,
  now,
  restoreClock,
  setTestNow,
} from "../../utils/clock.ts";
