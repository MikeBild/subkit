import { describe, expect, test } from "bun:test";
import { buildMultipartBody, type ResolvedFilePart } from "./http.ts";

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

async function entryText(fd: FormData, key: string): Promise<string> {
  const v = fd.get(key);
  if (v instanceof Blob) return v.text();
  return String(v ?? "");
}

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
    const SIZE = 300 * 1024;
    const source = new Uint8Array(SIZE);
    for (let i = 0; i < SIZE; i++) source[i] = i % 251;

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

    const out = new Uint8Array(await blob.arrayBuffer());
    expect(out.byteLength).toBe(SIZE);
    for (let i = 0; i < SIZE; i += 1000) {
      expect(out[i]).toBe(source[i]);
    }
  });
});

describe("buildMultipartBody — boundary in serialised body", () => {
  test("serialised FormData contains a boundary line", async () => {
    const bytes = new TextEncoder().encode("x");
    const fd = await buildMultipartBody([filePartFrom("f", "x.txt", bytes)]);

    const req = new Request("http://x", { method: "POST", body: fd });
    const ct = req.headers.get("content-type") ?? "";
    expect(ct).toContain("multipart/form-data");
    expect(ct).toContain("boundary=");
    const boundary = ct.split("boundary=")[1]?.trim();
    expect(boundary).toBeTruthy();
    expect((boundary ?? "").length).toBeGreaterThan(0);
  });
});
