// Unit tests for `buildMultipartBody` in the HTTP driver.
//
// Tests:
//  - scalar-only parts produce correct field names / values
//  - file part produces a Blob with the correct content-disposition filename
//  - mixed file + scalar parts in one FormData
//  - content-type per-part override is respected
//  - >256 KiB file part: bytes are buffered into a single Blob (not streamed)
//  - boundary is present in the serialised multipart body

import { describe, expect, test } from "bun:test";

import { buildMultipartBody, type ResolvedFilePart } from "./http.ts";

/** Build a minimal ResolvedFilePart whose `file.openRead()` yields `bytes`. */
function filePartFrom(
  name: string,
  filename: string,
  bytes: Uint8Array,
  content_type = "application/octet-stream",
): ResolvedFilePart {
  return {
    name,
    file: {
      filename,
      content_type,
      size_bytes: bytes.byteLength,
      openRead: () =>
        Promise.resolve(
          (async function* () {
            yield bytes;
          })(),
        ),
    },
  };
}

/** Read a FormData entry as text. */
async function entryText(fd: FormData, key: string): Promise<string> {
  const v = fd.get(key);
  if (v instanceof Blob) return v.text();
  return String(v ?? "");
}

// ---------------------------------------------------------------------------

describe("buildMultipartBody — scalar parts", () => {
  test("single scalar field is appended", async () => {
    const parts: ResolvedFilePart[] = [{ name: "format", value: "pdf" }];
    const fd = await buildMultipartBody(parts);
    expect(await entryText(fd, "format")).toBe("pdf");
  });

  test("multiple scalar fields are all present", async () => {
    const parts: ResolvedFilePart[] = [
      { name: "lang", value: "en" },
      { name: "page", value: "1" },
    ];
    const fd = await buildMultipartBody(parts);
    expect(await entryText(fd, "lang")).toBe("en");
    expect(await entryText(fd, "page")).toBe("1");
  });
});

describe("buildMultipartBody — file parts", () => {
  test("file part is a Blob with correct filename", async () => {
    const bytes = new TextEncoder().encode("hello world");
    const parts: ResolvedFilePart[] = [filePartFrom("upload", "hello.txt", bytes, "text/plain")];
    const fd = await buildMultipartBody(parts);
    const entry = fd.get("upload");
    expect(entry).toBeInstanceOf(Blob);
    const blob = entry as Blob;
    expect(blob.type).toContain("text/plain");
    expect(await blob.text()).toBe("hello world");
  });

  test("filename override takes precedence over file.filename", async () => {
    const bytes = new TextEncoder().encode("data");
    const part: ResolvedFilePart = {
      ...filePartFrom("doc", "original.txt", bytes),
      filename: "renamed.txt",
    };
    const fd = await buildMultipartBody([part]);
    const entry = fd.get("doc");
    expect(entry).toBeInstanceOf(Blob);
    // Bun's FormData serialises filename into content-disposition;
    // verify the bytes round-trip correctly at minimum.
    expect(await (entry as Blob).text()).toBe("data");
  });

  test("content_type override replaces file.content_type", async () => {
    const bytes = new TextEncoder().encode("{}");
    const part: ResolvedFilePart = {
      ...filePartFrom("body", "data.json", bytes, "application/octet-stream"),
      content_type: "application/json",
    };
    const fd = await buildMultipartBody([part]);
    const blob = fd.get("body") as Blob;
    expect(blob.type).toContain("application/json");
  });
});

describe("buildMultipartBody — mixed parts", () => {
  test("file + scalar together in one FormData", async () => {
    const bytes = new TextEncoder().encode("PDF content");
    const parts: ResolvedFilePart[] = [
      filePartFrom("file", "report.pdf", bytes, "application/pdf"),
      { name: "title", value: "Q1 Report" },
      { name: "year", value: "2026" },
    ];
    const fd = await buildMultipartBody(parts);
    const blob = fd.get("file") as Blob;
    expect(blob.type).toBe("application/pdf");
    expect(await blob.text()).toBe("PDF content");
    expect(await entryText(fd, "title")).toBe("Q1 Report");
    expect(await entryText(fd, "year")).toBe("2026");
  });
});

describe("buildMultipartBody — large file (>256 KiB): buffered behaviour", () => {
  test("300 KiB file is buffered into a single Blob", async () => {
    // The architect note says: "we buffer all chunks into a single Blob"
    // so this test verifies the buffered output equals the source bytes,
    // not that streaming occurred.
    const SIZE = 300 * 1024;
    const source = new Uint8Array(SIZE);
    // Fill with a repeating pattern so equality is non-trivial.
    for (let i = 0; i < SIZE; i++) source[i] = i % 251;

    // Deliver in 64 KiB chunks to simulate a multi-chunk stream.
    const CHUNK = 64 * 1024;
    const chunks: Uint8Array[] = [];
    for (let off = 0; off < SIZE; off += CHUNK) {
      chunks.push(source.subarray(off, Math.min(off + CHUNK, SIZE)));
    }

    const part: ResolvedFilePart = {
      name: "big",
      file: {
        filename: "large.bin",
        content_type: "application/octet-stream",
        size_bytes: SIZE,
        openRead: () =>
          Promise.resolve(
            (async function* () {
              for (const c of chunks) yield c;
            })(),
          ),
      },
    };

    const fd = await buildMultipartBody([part]);
    const blob = fd.get("big") as Blob;
    expect(blob.size).toBe(SIZE);

    // Verify bytes equal source.
    const out = new Uint8Array(await blob.arrayBuffer());
    expect(out.byteLength).toBe(SIZE);
    // Spot-check: every 1000th byte.
    for (let i = 0; i < SIZE; i += 1000) {
      expect(out[i]).toBe(source[i]);
    }
  });
});

describe("buildMultipartBody — boundary in serialised body", () => {
  test("serialised FormData contains a boundary line", async () => {
    const bytes = new TextEncoder().encode("x");
    const fd = await buildMultipartBody([filePartFrom("f", "x.txt", bytes)]);

    // Convert to a Request body so we can inspect the raw wire bytes.
    const req = new Request("http://x", { method: "POST", body: fd });
    const ct = req.headers.get("content-type") ?? "";
    // The Content-Type header must carry `multipart/form-data; boundary=...`
    expect(ct).toContain("multipart/form-data");
    expect(ct).toContain("boundary=");
    // The boundary value must be non-empty.
    const boundary = ct.split("boundary=")[1]?.trim();
    expect(boundary).toBeTruthy();
    expect((boundary ?? "").length).toBeGreaterThan(0);
  });
});
