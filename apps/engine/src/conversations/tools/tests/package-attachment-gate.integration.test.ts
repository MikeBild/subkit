import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { conversations, tenants } from "../../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import { attachInlineForTest } from "../../../files/test-helpers.ts";
import { PACKAGE_CONTENT_TYPE } from "../../../identity/portability/format.ts";
import { skillPackageArchive } from "../../../test-helpers/package-archive.ts";
import { pinAttachmentFileId } from "../../attachments.ts";
import { type GateSubject, prepareGate } from "../sdk-wrap/gate-subjects.ts";

let ctx: TestDb;
let tenant_id: string;
let conversation_id: string;
let other_conversation_id: string;
let package_file_id: string;

beforeAll(async () => {
  ctx = await createTestDb("package-attachment-gate");
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "pkg-gate-t", display_name: "Package Gate" })
    .returning();
  if (!t) throw new Error("seed tenant");
  tenant_id = t.id;
  const [conv, other] = await ctx.db
    .insert(conversations)
    .values([
      { tenant_id, status: "active" },
      { tenant_id, status: "active" },
    ])
    .returning();
  if (!conv || !other) throw new Error("seed conversations");
  conversation_id = conv.id;
  other_conversation_id = other.id;
  const attached = await attachInlineForTest({
    db: ctx.db,
    tenant_id,
    conversation_id,
    filename: "beispiele.subkit-package.zip",
    content: new Uint8Array(skillPackageArchive(["gate-alpha", "gate-beta"])),
    content_type: PACKAGE_CONTENT_TYPE,
    slug: "beispiele-subkit-package",
  });
  package_file_id = attached.file_id;
}, 60_000);

afterAll(async () => {
  await ctx.cleanup();
}, 30_000);

describe("package import from a chat attachment", () => {
  test("an @attachment reference to this chat's package becomes its file id", async () => {
    const pinned = await pinAttachmentFileId(
      { file_id: "@attachment:beispiele-subkit-package", expected_plan_digest: "d" },
      { db: ctx.db, tenant_id, conversation_id },
    );
    expect(pinned).toEqual({ file_id: package_file_id, expected_plan_digest: "d" });
  });

  test("references outside this chat stay untouched", async () => {
    const elsewhere = { file_id: "@attachment:beispiele-subkit-package" };
    expect(
      await pinAttachmentFileId(elsewhere, {
        db: ctx.db,
        tenant_id,
        conversation_id: other_conversation_id,
      }),
    ).toEqual(elsewhere);
    const unknown = { file_id: "@attachment:not-attached" };
    expect(await pinAttachmentFileId(unknown, { db: ctx.db, tenant_id, conversation_id })).toEqual(
      unknown,
    );
    const plain = { file_id: package_file_id };
    expect(await pinAttachmentFileId(plain, { db: ctx.db, tenant_id, conversation_id })).toBe(
      plain,
    );
  });

  test("the confirmation card names the package and its plan", async () => {
    const gate = await prepareGate(
      "apply_package_import",
      { file_id: package_file_id, expected_plan_digest: "d" },
      tenant_id,
      ctx.db,
    );
    const subjects = gate.pending_output?.subjects as GateSubject[];
    expect(subjects).toHaveLength(1);
    expect(subjects[0]?.title).toBe("beispiele.subkit-package.zip · 2 neu");
    expect(subjects[0]?.status).toBe("previewed");
    expect(gate.pending_output).toMatchObject({
      file_id: package_file_id,
      expected_plan_digest: "d",
    });
  });

  test("the plan follows an English interface", async () => {
    const gate = await prepareGate(
      "apply_package_import",
      { file_id: package_file_id, expected_plan_digest: "d" },
      tenant_id,
      ctx.db,
      "en",
    );
    const subjects = gate.pending_output?.subjects as GateSubject[];
    expect(subjects[0]?.title).toBe("beispiele.subkit-package.zip · 2 create");
  });

  test("an unreadable package does not block the confirmation card", async () => {
    const gate = await prepareGate(
      "apply_package_import",
      { file_id: "fid_00000000-0000-4000-8000-000000000000", expected_plan_digest: "d" },
      tenant_id,
      ctx.db,
    );
    const subjects = gate.pending_output?.subjects as GateSubject[];
    expect(subjects.map((subject) => subject.status)).toEqual(["not_found"]);
  });
});
