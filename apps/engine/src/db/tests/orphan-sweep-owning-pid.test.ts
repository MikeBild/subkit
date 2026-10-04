import { describe, expect, test } from "bun:test";
import { isPidAlive, owningPidFromTestDbName } from "./setup.ts";

describe("orphan sweep — owning pid", () => {
  test("extracts the pid from the createTestDb name layout", () => {
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
    expect(isPidAlive(4_294_967_294)).toBe(false);
  });

  test("a database named for THIS live process is not an orphan", () => {
    const name = `test_selfcheck_${process.pid}_deadbeefcafe`;
    const pid = owningPidFromTestDbName(name);
    expect(pid).toBe(process.pid);
    expect(pid !== null && isPidAlive(pid)).toBe(true);
  });
});
