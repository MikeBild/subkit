import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", "notarize-macos.sh");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const ACCEPTED = '{"id":"abc","status":"Accepted"}';
const INVALID = '{"id":"abc","status":"Invalid"}';

function run(responses: Array<{ code: number; body: string }>, env: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), "notarize-macos-"));
  roots.push(root);
  const bin = join(root, "bin");
  mkdirSync(bin);
  const calls = join(root, "calls");
  writeFileSync(calls, "");
  responses.forEach((response, i) => {
    writeFileSync(join(root, `response-${i + 1}`), response.body);
    writeFileSync(join(root, `code-${i + 1}`), String(response.code));
  });
  writeFileSync(join(bin, "uname"), "#!/bin/sh\necho Darwin\n", { mode: 0o755 });
  writeFileSync(join(bin, "ditto"), `#!/bin/sh\necho "ditto $*" >> '${calls}'\n`, { mode: 0o755 });
  writeFileSync(
    join(bin, "xcrun"),
    `#!/bin/sh\necho "xcrun $*" >> '${calls}'\nn=$(grep -c '^xcrun' '${calls}')\ncat '${root}'/response-$n\nexit $(cat '${root}'/code-$n)\n`,
    { mode: 0o755 },
  );
  const binary = join(root, "engine");
  writeFileSync(binary, "binary");
  const key = join(root, "AuthKey_TEST.p8");
  writeFileSync(key, "placeholder");
  const result = spawnSync("sh", [SCRIPT, binary], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      APPLE_API_KEY: key,
      APPLE_API_KEY_ID: "KEYID",
      APPLE_API_ISSUER: "ISSUER",
      ...env,
    },
  });
  return { ...result, calls: readFileSync(calls, "utf8"), key };
}

describe("notarize-macos.sh", () => {
  test("zips the binary and submits it with the key path, waiting for the result", () => {
    const result = run([{ code: 0, body: ACCEPTED }]);
    expect(result.status).toBe(0);
    expect(result.calls).toContain("ditto -c -k --keepParent");
    expect(result.calls).toContain(
      `--key ${result.key} --key-id KEYID --issuer ISSUER --wait --timeout 45m --output-format json`,
    );
    expect(result.calls.match(/^xcrun/gm)?.length).toBe(1);
  });

  test("retries a failed upload once", () => {
    const result = run([
      { code: 1, body: "" },
      { code: 0, body: ACCEPTED },
    ]);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("trying once more");
    expect(result.calls.match(/^xcrun/gm)?.length).toBe(2);
  });

  test("does not retry when Apple answered, and fails when Apple rejects", () => {
    const answered = run([{ code: 1, body: INVALID }]);
    expect(answered.status).not.toBe(0);
    expect(answered.calls.match(/^xcrun/gm)?.length).toBe(1);
    const rejected = run([{ code: 0, body: INVALID }]);
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain("did not accept");
  });

  test("needs the key as a file path", () => {
    const result = run([{ code: 0, body: ACCEPTED }], { APPLE_API_KEY: "inline key text" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("path of the key file");
    expect(result.calls).toBe("");
  });
});
