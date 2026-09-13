// LOCAL-SK-SWEEP-DROPPT-LEBENDE-DB — the orphan sweep must not drop a
// database whose owning process is still running.
//
// `createTestDb` closes its admin connection right after CREATE DATABASE
// and `new Pool()` does not dial until the first query, so a healthy
// brand-new database has ZERO rows in pg_stat_activity for a moment. The
// old sweep predicate ("no connections") could not tell that window
// apart from a real orphan, and under the release gate a sibling test
// process dropped a live database out from under its owner:
//
//   3D000  database "test_conv_chat_rehydrate_<pid>_…" does not exist
//          "It seems to have just been dropped or renamed."
//
// The name carries the creating pid, and an orphan is by definition the
// leftover of a process that is gone. These cases pin that predicate.

import { describe, expect, test } from "bun:test";

import { isPidAlive, owningPidFromTestDbName } from "./setup.ts";

describe("orphan sweep — owning pid", () => {
  test("extracts the pid from the createTestDb name layout", () => {
    // Label with underscores — the pid is the second-to-last segment.
    expect(owningPidFromTestDbName("test_conv_chat_rehydrate_81415_35c4c5249927")).toBe(81415);
    expect(owningPidFromTestDbName("test_zzprobe_12_abcdef012345")).toBe(12);
  });

  test("returns null for names that predate the convention", () => {
    expect(owningPidFromTestDbName("test_legacy")).toBeNull();
    expect(owningPidFromTestDbName("test_no_pid_here_deadbeef")).toBeNull();
    expect(owningPidFromTestDbName("postgres")).toBeNull();
  });

  test("recognises this very process as alive", () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  test("reports an unused pid as dead", () => {
    // Above the default pid_max on macOS and Linux, so it cannot exist.
    expect(isPidAlive(4_294_967_294)).toBe(false);
  });

  test("a database named for THIS live process is not an orphan", () => {
    const name = `test_selfcheck_${process.pid}_deadbeefcafe`;
    const pid = owningPidFromTestDbName(name);
    expect(pid).toBe(process.pid);
    // This is the exact combination the old predicate got wrong:
    // no connections yet, but the owner is running.
    expect(pid !== null && isPidAlive(pid)).toBe(true);
  });
});
