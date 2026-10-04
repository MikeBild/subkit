import { describe, expect, test } from "bun:test";
import {
  checkIngestGuard,
  KNOWLEDGE_INGEST_MAX_BYTES,
} from "../settings-ui/lib/knowledge-ingest-guard.ts";

const FAKE_HOME_UNIX = "/home/operator";
const FAKE_HOME_WIN = "C:\\Users\\operator";

describe("checkIngestGuard — Unix", () => {
  test("rejects /etc, /proc, /sys, /var/log, /var/lib, /var/run, /var/spool, /dev, /root prefixes", () => {
    for (const path of [
      "/etc/passwd",
      "/proc/self/environ",
      "/sys/class/net",
      "/var/log/auth.log",
      "/var/lib/postgresql/data",
      "/var/run/secrets/x",
      "/var/spool/cron",
      "/dev/null",
      "/root/.bashrc",
    ]) {
      const r = checkIngestGuard({
        absolutePath: path,
        sizeBytes: 1024,
        home: FAKE_HOME_UNIX,
        platform: "linux",
      });
      expect(r.rejected).toBe(true);
      expect(r.reason).toContain("OS-internal");
    }
  });

  test("accepts /var/folders/... (macOS tmpdir) and /var/tmp", () => {
    expect(
      checkIngestGuard({
        absolutePath: "/var/folders/abc/T/playbook.md",
        sizeBytes: 1024,
        home: FAKE_HOME_UNIX,
        platform: "darwin",
      }).rejected,
    ).toBe(false);
    expect(
      checkIngestGuard({
        absolutePath: "/var/tmp/scratch.md",
        sizeBytes: 1024,
        home: FAKE_HOME_UNIX,
        platform: "linux",
      }).rejected,
    ).toBe(false);
  });

  test("rejects credentials-root dotfiles under HOME", () => {
    for (const sub of [
      ".ssh/id_rsa",
      ".aws/credentials",
      ".gnupg/gpg.conf",
      ".kube/config",
      ".docker/config.json",
      ".config/sk/cred",
      ".sk/config.json",
    ]) {
      const r = checkIngestGuard({
        absolutePath: `${FAKE_HOME_UNIX}/${sub}`,
        sizeBytes: 1024,
        home: FAKE_HOME_UNIX,
        platform: "linux",
      });
      expect(r.rejected).toBe(true);
      expect(r.reason).toContain("dotfile");
    }
  });

  test("accepts a project-path file under HOME", () => {
    const r = checkIngestGuard({
      absolutePath: `${FAKE_HOME_UNIX}/projects/notes.md`,
      sizeBytes: 12345,
      home: FAKE_HOME_UNIX,
      platform: "linux",
    });
    expect(r.rejected).toBe(false);
  });

  test("accepts /tmp / /opt as non-system roots", () => {
    expect(
      checkIngestGuard({
        absolutePath: "/tmp/draft.md",
        sizeBytes: 1024,
        home: FAKE_HOME_UNIX,
        platform: "linux",
      }).rejected,
    ).toBe(false);
    expect(
      checkIngestGuard({
        absolutePath: "/opt/data/spec.pdf",
        sizeBytes: 1024,
        home: FAKE_HOME_UNIX,
        platform: "linux",
      }).rejected,
    ).toBe(false);
  });
});

describe("checkIngestGuard — Windows", () => {
  test("rejects C:\\Windows, C:\\Program Files, C:\\ProgramData (case-insensitive)", () => {
    for (const path of [
      "C:\\Windows\\System32\\hosts",
      "c:\\program files\\subkit\\bin",
      "C:\\Program Files (x86)\\Common\\foo",
      "C:\\ProgramData\\state.json",
    ]) {
      const r = checkIngestGuard({
        absolutePath: path,
        sizeBytes: 1024,
        home: FAKE_HOME_WIN,
        platform: "win32",
      });
      expect(r.rejected).toBe(true);
      expect(r.reason).toContain("OS-internal");
    }
  });

  test("rejects AppData and ~/.ssh under the Windows HOME", () => {
    for (const sub of ["AppData\\Local\\foo", ".ssh\\id_rsa", ".aws\\credentials"]) {
      const r = checkIngestGuard({
        absolutePath: `${FAKE_HOME_WIN}\\${sub}`,
        sizeBytes: 1024,
        home: FAKE_HOME_WIN,
        platform: "win32",
      });
      expect(r.rejected).toBe(true);
      expect(r.reason).toContain("dotfile");
    }
  });

  test("accepts a project-path file under the Windows HOME", () => {
    const r = checkIngestGuard({
      absolutePath: `${FAKE_HOME_WIN}\\Documents\\notes.md`,
      sizeBytes: 12345,
      home: FAKE_HOME_WIN,
      platform: "win32",
    });
    expect(r.rejected).toBe(false);
  });
});

describe("checkIngestGuard — size cap", () => {
  test("rejects files exactly above the 50 MB cap", () => {
    const r = checkIngestGuard({
      absolutePath: "/tmp/big.bin",
      sizeBytes: KNOWLEDGE_INGEST_MAX_BYTES + 1,
      home: FAKE_HOME_UNIX,
      platform: "linux",
    });
    expect(r.rejected).toBe(true);
    expect(r.reason).toContain("max 50 MB");
  });

  test("accepts files exactly at the cap", () => {
    const r = checkIngestGuard({
      absolutePath: "/tmp/exact.bin",
      sizeBytes: KNOWLEDGE_INGEST_MAX_BYTES,
      home: FAKE_HOME_UNIX,
      platform: "linux",
    });
    expect(r.rejected).toBe(false);
  });
});
