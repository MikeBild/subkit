import { expect, test } from "bun:test";
import { resolveMultipartInput } from "./multipart-input.ts";

const file = {
  $file: "fid_11111111-2222-4333-8444-555555555555",
  $range: { start: 262144, length: 42 },
};
const ctx = {
  db: {} as never,
  tenant_id: "tenant",
  environment: "dev" as const,
  input: { file },
  scope: { $item: { file, index: 1 }, $caller: { principalId: "caller" } },
};

test("multipart runtime inputs preserve file references and byte ranges", async () => {
  expect((await resolveMultipartInput({ name: "data", file: `\${input.file}` }, ctx)).file).toEqual(
    file,
  );
  expect((await resolveMultipartInput({ name: "data", file: `\${item.file}` }, ctx)).file).toEqual(
    file,
  );
  expect((await resolveMultipartInput({ name: "index", value: `\${item.index}` }, ctx)).value).toBe(
    "1",
  );
  expect(
    (await resolveMultipartInput({ name: "reporter", value: `\${caller.principalId}` }, ctx)).value,
  ).toBe("caller");
});

test("multipart refuses missing input and malformed file references", async () => {
  await expect(
    resolveMultipartInput({ name: "data", file: `\${input.missing}` }, ctx),
  ).rejects.toThrow();
  await expect(
    resolveMultipartInput(
      { name: "data", file: `\${input.file}` },
      { ...ctx, input: { file: { $file: "another-tenant" } } },
    ),
  ).rejects.toThrow();
  await expect(
    resolveMultipartInput({ name: "index", value: `\${input.missing}` }, ctx),
  ).rejects.toThrow();
});
