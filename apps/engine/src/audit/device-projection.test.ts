import { describe, expect, test } from "bun:test";
import { DEVICE_REFUSALS } from "@shared/device/protocol.ts";
import { deviceEffectAuditMetadata, relativePathDigest } from "./device-metadata.ts";
import { DEVICE_DETAIL_CHECKS } from "./device-projection.ts";
import { AUDIT_ACCESS_TYPES, projectAuditEntry } from "./projection.ts";
import { AuditAction, type AuditEntry } from "./types.ts";

const DEVICE = "66666666-6666-4666-8666-666666666666";
const INSTALLATION = "44444444-4444-4444-8444-444444444444";
const EXECUTION = "77777777-7777-4777-8777-777777777777";
const CONFIRMATION = "99999999-9999-4999-8999-999999999999";
const JOB = "88888888-8888-4888-8888-888888888888";
const COMMAND = "c".repeat(64);
const DIGEST = "d".repeat(64);

function entry(overrides: Partial<AuditEntry>): AuditEntry {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    ts: new Date("2026-11-21T10:15:30.000Z"),
    tenant_id: "22222222-2222-4222-8222-222222222222",
    actor_type: "user",
    actor_id: null,
    action: AuditAction.DEVICE_COMMAND_COMPLETED,
    resource_type: "device_command",
    resource_id: null,
    result: "success",
    trace_id: "trace",
    ip: null,
    user_agent: null,
    before: null,
    after: null,
    reason: null,
    metadata: {},
    ...overrides,
  };
}

const DEVICE_ACTIONS: string[] = Object.values(AuditAction).filter(
  (action) =>
    action.startsWith("device") ||
    action.startsWith("local_") ||
    action === "workspace.moved_to_server",
);

describe("device audit actions", () => {
  test("every device and local action has its own detail allowlist", () => {
    expect(DEVICE_ACTIONS.sort()).toEqual(Object.keys(DEVICE_DETAIL_CHECKS).sort());
    expect(DEVICE_ACTIONS).toHaveLength(21);
  });

  test("a completed file write shows device, folder, path and command", () => {
    const metadata = deviceEffectAuditMetadata(
      {
        device_id: DEVICE,
        device_label: "MacBook Pro (Mike)",
        capability: "files",
        folder_id: "folder-rechnungen",
        relative_path: "Berichte/Woche 47 – Übersicht.md",
        command_id: COMMAND,
        generation: 3,
        execution_id: EXECUTION,
      },
      "standard",
    );
    const projected = projectAuditEntry(entry({ metadata }));
    expect(projected.details).toEqual({
      device_id: DEVICE,
      device_label: "MacBook Pro (Mike)",
      capability: "files",
      folder_id: "folder-rechnungen",
      relative_path: "Berichte/Woche 47 – Übersicht.md",
      relative_path_digest: relativePathDigest({
        device_id: DEVICE,
        folder_id: "folder-rechnungen",
        relative_path: "Berichte/Woche 47 – Übersicht.md",
      }),
      command_id: COMMAND,
      generation: 3,
      execution_id: EXECUTION,
    });
    expect(projected.execution_id).toBe(EXECUTION);
  });

  test("a device step of a chat or task job shows the job it belonged to", () => {
    const metadata = deviceEffectAuditMetadata(
      {
        device_id: DEVICE,
        device_label: "MacBook Pro (Mike)",
        capability: "browser",
        origin: "https://tisch.example",
        command_id: COMMAND,
        generation: 2,
        task_run_id: JOB,
        job_id: JOB,
      },
      "standard",
    );
    expect(projectAuditEntry(entry({ metadata })).details).toMatchObject({
      task_run_id: JOB,
      job_id: JOB,
    });
    expect(() =>
      deviceEffectAuditMetadata(
        {
          device_id: DEVICE,
          device_label: "MacBook Pro (Mike)",
          capability: "browser",
          command_id: COMMAND,
          generation: 2,
          job_id: "job-1",
        },
        "standard",
      ),
    ).toThrow();
    const forged = projectAuditEntry(
      entry({
        metadata: { device_id: DEVICE, capability: "browser", command_id: COMMAND, job_id: "x" },
      }),
    );
    expect(forged.details).not.toHaveProperty("job_id");
  });

  test("a sensitive-privacy workflow keeps only the path digest", () => {
    const metadata = deviceEffectAuditMetadata(
      {
        device_id: DEVICE,
        device_label: "MacBook Pro (Mike)",
        capability: "files",
        folder_id: "folder-rechnungen",
        relative_path: "Gehalt/2026.pdf",
        command_id: COMMAND,
        generation: 0,
      },
      "sensitive",
    );
    expect(metadata.relative_path).toBeUndefined();
    expect(metadata.relative_path_digest).toMatch(/^[0-9a-f]{64}$/);
    const projected = projectAuditEntry(entry({ metadata }));
    expect(JSON.stringify(projected)).not.toContain("Gehalt");
  });

  test("a refusal shows its code and the code counts as a safe reason", () => {
    for (const code of DEVICE_REFUSALS) {
      const projected = projectAuditEntry(
        entry({
          action: AuditAction.DEVICE_COMMAND_REFUSED,
          result: "denied",
          reason: code,
          metadata: {
            device_id: DEVICE,
            capability: "browser",
            origin: "https://example.com",
            command_id: COMMAND,
            generation: 1,
            code,
          },
        }),
      );
      expect(projected.reason).toBe(code);
      expect((projected.details as Record<string, unknown>).code).toBe(code);
    }
  });

  test("unknown codes, secrets and foreign fields never reach the projection", () => {
    const projected = projectAuditEntry(
      entry({
        action: AuditAction.DEVICE_COMMAND_LOST,
        reason: "the server said: open http://192.168.1.1",
        metadata: {
          device_id: "not-a-uuid",
          origin: "javascript:alert(1)",
          command_id: "short",
          code: "made_up",
          generation: -1,
          args: { password: "hunter2" },
          relative_path: "token=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789",
        },
      }),
    );
    const details = projected.details as Record<string, unknown>;
    expect(details.device_id).toBeUndefined();
    expect(details.origin).toBeUndefined();
    expect(details.command_id).toBeUndefined();
    expect(details.code).toBeUndefined();
    expect(details.generation).toBeUndefined();
    expect(details.args).toBeUndefined();
    expect(projected.reason).toBeNull();
    expect(projected.reason_redacted).toBe(true);
    expect(JSON.stringify(projected)).not.toContain("hunter2");
    expect(JSON.stringify(projected)).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
  });

  test("allowances show kind, item, access and who entered them", () => {
    const projected = projectAuditEntry(
      entry({
        action: AuditAction.DEVICE_SITE_ALLOWED,
        resource_type: "device_runner",
        metadata: {
          device_id: DEVICE,
          device_label: "MacBook Pro (Mike)",
          kind: "site",
          item_id: "http://192.168.1.10:8080",
          private: true,
          entered_by: "person",
          digest: DIGEST,
        },
      }),
    );
    expect(projected.details).toEqual({
      device_id: DEVICE,
      device_label: "MacBook Pro (Mike)",
      kind: "site",
      item_id: "http://192.168.1.10:8080",
      private: true,
      entered_by: "person",
      digest: DIGEST,
    });
  });

  test("enrollment, confirmation and local workspace entries keep their ids", () => {
    expect(
      projectAuditEntry(
        entry({
          action: AuditAction.DEVICE_RUNNER_ENROLLED,
          resource_type: "device_runner",
          metadata: {
            device_id: DEVICE,
            device_label: "MacBook Pro (Mike)",
            installation_id: INSTALLATION,
            runner_version: "11.3.0",
          },
        }),
      ).details,
    ).toEqual({
      device_id: DEVICE,
      device_label: "MacBook Pro (Mike)",
      installation_id: INSTALLATION,
      runner_version: "11.3.0",
    });
    expect(
      projectAuditEntry(
        entry({
          action: AuditAction.LOCAL_CONFIRMATION_GRANTED,
          resource_type: "local_confirmation",
          metadata: {
            confirmation_id: CONFIRMATION,
            command_id: COMMAND,
            binding_hash: DIGEST,
            device_id: DEVICE,
            execution_id: EXECUTION,
            job_id: JOB,
          },
        }),
      ).details,
    ).toEqual({
      confirmation_id: CONFIRMATION,
      command_id: COMMAND,
      binding_hash: DIGEST,
      device_id: DEVICE,
      execution_id: EXECUTION,
      job_id: JOB,
    });
    expect(
      projectAuditEntry(
        entry({
          action: AuditAction.LOCAL_BACKUP_CREATED,
          resource_type: "local_workspace",
          metadata: { backup_id: "backup-2026-11-21", size_bytes_bucket: "<100MB" },
        }),
      ).details,
    ).toEqual({ backup_id: "backup-2026-11-21", size_bytes_bucket: "<100MB" });
  });

  test("a runner credential is a known access type", () => {
    expect(AUDIT_ACCESS_TYPES).toContain("device_runner");
    expect(
      projectAuditEntry(entry({ metadata: { audit_access_type: "device_runner" } })).access_type,
    ).toBe("device_runner");
  });
});
