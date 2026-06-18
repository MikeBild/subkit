// Test-only helpers for the robots LRU.
//
// Lives in a `.test-helpers.ts` sibling so the production module
// (`robots-cache.ts`) exports stay clean. Only test files and other
// test-helper modules import from here; bundlerVisitor tree-shakes
// this file out of the production engine binary.

import { _internalRobotsCacheRef } from "./robots-cache.ts";

/** Drop every cache entry. Call between tests to keep them isolated. */
export function __resetRobotsCacheForTests(): void {
  _internalRobotsCacheRef().clear();
}

/** Stats for assertions (cache size, etc.). */
export function __getRobotsCacheStatsForTests(): { size: number } {
  return { size: _internalRobotsCacheRef().size };
}
