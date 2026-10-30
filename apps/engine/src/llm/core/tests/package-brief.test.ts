import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { conversations, tenants } from "../../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import { attachInlineForTest } from "../../../files/test-helpers.ts";
import { PACKAGE_CONTENT_TYPE } from "../../../identity/portability/format.ts";
import { skillPackageArchive } from "../../../test-helpers/package-archive.ts";
import { writeDeterministicZip } from "../../../utils/zip-write.ts";
import { getStaticCapabilities } from "../capabilities.ts";
import { buildFileContentBlocks } from "../file-context.ts";

let ctx: TestDb;
let tenant_id: string;
let conversation_id: string;

beforeAll(async () => {
  ctx = await createTestDb("package-brief");
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "pkg-brief-t", display_name: "Package Brief" })
    .returning();
  if (!t) throw new Error("seed tenant");
  tenant_id = t.id;
  const [conv] = await ctx.db
    .insert(conversations)
    .values({ tenant_id, status: "active" })
    .returning();
  if (!conv) throw new Error("seed conv");
  conversation_id = conv.id;
}, 60_000);

afterAll(async () => {
  await ctx.cleanup();
}, 30_000);

async function textOf(
  filename: string,
  content: Uint8Array,
  content_type: string,
  slug: string,
): Promise<{ file_id: string; text: string }> {
  const att = await attachInlineForTest({
    db: ctx.db,
    tenant_id,
    conversation_id,
    filename,
    content,
    content_type,
    slug,
  });
  const result = await buildFileContentBlocks({
    db: ctx.db,
    tenant_id,
    capabilities: getStaticCapabilities("mock"),
    fids: [att.file_id],
  });
  const block = result.blocks[0];
  if (block?.strategy !== "text_extract") throw new Error("expected a text block");
  return { file_id: att.file_id, text: block.text };
}

describe("SubKit package attachments in the model context", () => {
  test("the model sees a brief with the file id, never the package entries", async () => {
    const secret = "Never reveal this skill body to the model";
    const { file_id, text } = await textOf(
      "beispiele.subkit-package.zip",
      new Uint8Array(skillPackageArchive(["brief-alpha", "brief-beta"], secret)),
      PACKAGE_CONTENT_TYPE,
      "beispiele-subkit-package",
    );
    expect(text).toContain(file_id);
    expect(text).toContain("package_id: tenant-export:source");
    expect(text).toContain("items: 2 skill");
    expect(text).toContain("preview_package_import");
    expect(text).not.toContain(secret);
    expect(text).not.toContain("brief-alpha");
  });

  test("a damaged package is named as invalid without its contents", async () => {
    const damaged = writeDeterministicZip(new Map([["manifest.json", Buffer.from("{}")]]));
    const { text } = await textOf(
      "broken.subkit-package.zip",
      new Uint8Array(damaged),
      PACKAGE_CONTENT_TYPE,
      "broken-subkit-package",
    );
    expect(text).toContain("package_manifest_invalid");
    expect(text).not.toContain("{}");
  });

  test("an ordinary zip is still extracted as before", async () => {
    const plain = writeDeterministicZip(new Map([["notes.txt", Buffer.from("plain zip notes")]]));
    const { text } = await textOf(
      "notes.zip",
      new Uint8Array(plain),
      "application/zip",
      "notes-zip",
    );
    expect(text).toContain("plain zip notes");
  });
});
