import { describe, expect, test } from "bun:test";
import { generateSshKeyPair } from "../test-helpers/sftp-server.ts";
import { redact } from "./redact.ts";
import {
  referencesKeyMaterialPath,
  SECRET_PATTERNS,
  SENSITIVE_KEY_PATTERN,
  scrubSecrets,
  scrubString,
} from "./scrub-secrets.ts";

describe("scrub-secrets", () => {
  describe("string-mode scrubbing", () => {
    test("redacts a DigitalOcean PAT (dop_v1_…)", () => {
      const token = "dop_v1_a9053683abcdefabcdefabcdefabcdefabcdef";
      const out = scrubString(`auth: ${token}`);
      expect(out).not.toContain(token);
      expect(out).toContain("***REDACTED:pat***");
    });

    test("redacts a GitHub PAT (ghp_…)", () => {
      const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
      const out = scrubString(`bearer ${token} ok`);
      expect(out).not.toContain(token);
      expect(out).toContain("***REDACTED:pat***");
    });

    test("redacts every GitHub flavour: gho_, ghu_, ghs_", () => {
      for (const prefix of ["gho_", "ghu_", "ghs_"] as const) {
        const token = `${prefix}abcdefghijklmnopqrstuvwxyz123456`;
        const out = scrubString(`x ${token} y`);
        expect(out).not.toContain(token);
        expect(out).toContain("***REDACTED:pat***");
      }
    });

    test("redacts a GitLab PAT (glpat-…)", () => {
      const token = "glpat-abcdefghijklmnopqrstuvwxyz123456";
      const out = scrubString(token);
      expect(out).not.toContain(token);
      expect(out).toContain("***REDACTED:pat***");
    });

    test("redacts an Anthropic key (sk-ant-…)", () => {
      const token = "sk-ant-api03-abcdefghijklmnopqrstuv";
      const out = scrubString(token);
      expect(out).not.toContain(token);
      expect(out).toContain("***REDACTED:pat***");
    });

    test("redacts a generic sk- key", () => {
      const token = "sk-abcdefghijklmnopqrstuvwxyz0123";
      const out = scrubString(`OPENAI_KEY=${token}`);
      expect(out).not.toContain(token);
      expect(out).toContain("***REDACTED:pat***");
    });

    test("redacts a Slack bot token (xoxb-…) and user token (xoxp-…)", () => {
      const bot = "xoxb-1234567890-1234567890-abcdefABCDEF";
      const user = "xoxp-1234567890-1234567890-abcdefABCDEF";
      const out = scrubString(`bot=${bot} user=${user}`);
      expect(out).not.toContain(bot);
      expect(out).not.toContain(user);
    });

    test("redacts a Bearer header", () => {
      const out = scrubString("Authorization: Bearer abc123.def-456_xyz");
      expect(out).not.toContain("abc123.def-456_xyz");
      expect(out).toContain("***REDACTED:bearer***");
    });

    test("redacts a JWT (eyJ…)", () => {
      const jwt =
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefSignaturePart";
      const out = scrubString(`token=${jwt}`);
      expect(out).not.toContain(jwt);
      expect(out).toContain("***REDACTED:jwt***");
    });

    test("redacts an AWS access key id (AKIA + 16 upper alnum)", () => {
      const key = "AKIAIOSFODNN7EXAMPLE";
      const out = scrubString(`AWS_ACCESS_KEY_ID=${key}`);
      expect(out).not.toContain(key);
      expect(out).toContain("***REDACTED:aws_key***");
    });

    test("does not false-match short non-secret strings", () => {
      const out = scrubString("ok=true status=ready name=workflow-123");
      expect(out).toBe("ok=true status=ready name=workflow-123");
    });
  });

  describe("presigned-URL query-string redaction", () => {
    test("redacts an S3 sigv4 presigned PUT URL", () => {
      const url =
        "https://my-bucket.s3.amazonaws.com/tenants/abc/2026/05/file?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20260514%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20260514T120000Z&X-Amz-Expires=3600&X-Amz-SignedHeaders=host&X-Amz-Signature=abc123def456";
      const out = scrubString(url);
      expect(out).not.toContain("X-Amz-Signature");
      expect(out).not.toContain("X-Amz-Credential");
      expect(out).not.toContain("AKIAIOSFODNN7EXAMPLE");
      expect(out).toContain("?<presign-redacted>");
      expect(out.startsWith("https://my-bucket.s3.amazonaws.com/tenants/abc/2026/05/file")).toBe(
        true,
      );
    });

    test("redacts a GCS V4 signed URL", () => {
      const url =
        "https://storage.googleapis.com/my-bucket/path/to/object?X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Credential=service-account%40project.iam.gserviceaccount.com%2F20260514%2Fauto%2Fstorage%2Fgoog4_request&X-Goog-Date=20260514T120000Z&X-Goog-Expires=900&X-Goog-SignedHeaders=host&X-Goog-Signature=abcdef0123456789";
      const out = scrubString(url);
      expect(out).not.toContain("X-Goog-Signature");
      expect(out).not.toContain("X-Goog-Credential");
      expect(out).toContain("?<presign-redacted>");
      expect(out.startsWith("https://storage.googleapis.com/my-bucket/path/to/object")).toBe(true);
    });

    test("redacts a generic HMAC presign with `signature=` (lowercase)", () => {
      const url =
        "https://files.example.com/v1/files/fid_abc/upload?expires=1700000000&signature=deadbeefcafe";
      const out = scrubString(url);
      expect(out).not.toContain("signature=deadbeefcafe");
      expect(out).not.toContain("expires=1700000000");
      expect(out).toContain("?<presign-redacted>");
      expect(out.startsWith("https://files.example.com/v1/files/fid_abc/upload")).toBe(true);
    });

    test("redacts a generic HMAC presign with `Signature=` (uppercase)", () => {
      const url = "https://files.example.com/v1/files/fid_xyz/upload?token=abc&Signature=zzz9";
      const out = scrubString(url);
      expect(out).not.toContain("Signature=zzz9");
      expect(out).toContain("?<presign-redacted>");
    });

    test("does NOT redact a normal URL with non-signature query params", () => {
      const url = "https://example.com/api?page=1&limit=20";
      const out = scrubString(url);
      expect(out).toBe(url);
    });

    test("redacts presign URLs nested inside an audit metadata object", () => {
      const presign =
        "https://bucket.s3.amazonaws.com/key?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=topsecret";
      const audit = {
        action: "file.batch_created",
        metadata: {
          presign_url: presign,
          files: [{ id: "fid_1", upload_url: presign }],
          notes: `Issued presign URL ${presign} for tenant t1.`,
        },
      };
      const out = scrubSecrets(audit);
      const json = JSON.stringify(out);
      expect(json).not.toContain("topsecret");
      expect(json).not.toContain("X-Amz-Signature");
      expect(json).toContain("?<presign-redacted>");
      expect(json).toContain("https://bucket.s3.amazonaws.com/key");
    });
  });

  describe("object-mode walking", () => {
    test("redacts a sensitive-key string value entirely", () => {
      const out = scrubSecrets({
        token: "anything-shaped-not-a-pat-but-still-a-token",
        api_key: "v1.foo.bar",
        password: "hunter2",
        api_Key: "another",
        normal: "ok",
      }) as Record<string, string>;
      expect(out.token).toBe("***REDACTED:key_value***");
      expect(out.api_key).toBe("***REDACTED:key_value***");
      expect(out.password).toBe("***REDACTED:key_value***");
      expect(out.api_Key).toBe("***REDACTED:key_value***");
      expect(out.normal).toBe("ok");
    });

    test("recursively scrubs nested objects", () => {
      const input = {
        request: {
          headers: { Authorization: "Bearer abc.def.ghi" },
          body: {
            secret: "v1.foo",
            note: "use ghp_abcdefghijklmnopqrstuvwxyz123456 to push",
          },
        },
      };
      const out = scrubSecrets(input);
      const json = JSON.stringify(out);
      expect(json).not.toContain("abc.def.ghi");
      expect(json).not.toContain("v1.foo");
      expect(json).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz123456");
      expect(json).toContain("***REDACTED:");
    });

    test("walks arrays", () => {
      const out = scrubSecrets([
        "Bearer abc.def.ghi",
        { token: "leak" },
        ["nested", "ghp_abcdefghijklmnopqrstuvwxyz123456"],
      ]);
      expect(JSON.stringify(out)).not.toContain("abc.def.ghi");
      expect(JSON.stringify(out)).not.toContain("ghp_abcde");
      expect(JSON.stringify(out)).not.toContain('"leak"');
    });

    test("survives a circular reference without throwing", () => {
      const a: Record<string, unknown> = { name: "a" };
      const b: Record<string, unknown> = { name: "b", a };
      a.b = b;
      const out = scrubSecrets(a);
      expect(JSON.stringify(out)).toContain("[circular]");
    });

    test("respects depth limit on pathological nesting", () => {
      let cur: Record<string, unknown> = { leaf: "ghp_abcdefghijklmnopqrstuvwxyz123456" };
      for (let i = 0; i < 30; i++) cur = { next: cur };
      const out = scrubSecrets(cur);
      expect(JSON.stringify(out)).toContain("[depth-exceeded]");
    });

    test("primitives pass through", () => {
      expect(scrubSecrets(42)).toBe(42);
      expect(scrubSecrets(true)).toBe(true);
      expect(scrubSecrets(null)).toBe(null);
      expect(scrubSecrets(undefined)).toBe(undefined);
    });

    test("roundtrip — JSON.stringify on the result contains no token substring", () => {
      const inputs: ReadonlyArray<{ kind: string; sample: string }> = [
        { kind: "do", sample: "dop_v1_a9053683abcdefabcdefabcdefabcdefabcd" },
        { kind: "gh", sample: "ghp_abcdefghijklmnopqrstuvwxyz123456" },
        { kind: "anth", sample: "sk-ant-api03-abcdefghijklmnopqrstuv" },
        {
          kind: "jwt",
          sample:
            "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefSignature",
        },
        { kind: "aws", sample: "AKIAIOSFODNN7EXAMPLE" },
      ];
      for (const { sample } of inputs) {
        const out = scrubSecrets({
          message: `Found token: ${sample} in payload`,
          nested: { value: sample, list: [sample, sample] },
        });
        const json = JSON.stringify(out);
        expect(json).not.toContain(sample);
      }
    });
  });

  describe("module exports", () => {
    test("SECRET_PATTERNS is non-empty and well-formed", () => {
      expect(SECRET_PATTERNS.length).toBeGreaterThan(0);
      for (const { kind, regex } of SECRET_PATTERNS) {
        expect(typeof kind).toBe("string");
        expect(regex).toBeInstanceOf(RegExp);
        expect(regex.global).toBe(true);
      }
    });

    test("SENSITIVE_KEY_PATTERN matches expected key shapes", () => {
      expect(SENSITIVE_KEY_PATTERN.test("token")).toBe(true);
      expect(SENSITIVE_KEY_PATTERN.test("api_key")).toBe(true);
      expect(SENSITIVE_KEY_PATTERN.test("api-key")).toBe(true);
      expect(SENSITIVE_KEY_PATTERN.test("apiKey")).toBe(true);
      expect(SENSITIVE_KEY_PATTERN.test("Authorization")).toBe(true);
      expect(SENSITIVE_KEY_PATTERN.test("client_secret")).toBe(true);
      expect(SENSITIVE_KEY_PATTERN.test("credential")).toBe(true);
      expect(SENSITIVE_KEY_PATTERN.test("name")).toBe(false);
      expect(SENSITIVE_KEY_PATTERN.test("status")).toBe(false);
    });
  });
});

describe("referencesKeyMaterialPath", () => {
  const keyMaterial = [
    "/etc/ssl/private/server.key",
    "`/srv/app/tls.key`",
    "the cert lives in ./certs/ca.pem",
    "(server.pem)",
    "import bundle.p12 first",
    "client.pfx",
    "copy .env.local before starting",
    "the .env file holds it",
    "config/.env",
    "see ~/.ssh/config",
    "$HOME/.ssh",
    "/home/me/.gnupg",
    "id_ed25519 is the deploy key",
    "/etc/subkit/master.key",
    "/etc/app/secrets.json",
    "~/.aws/credentials",
    "/run/secrets/db",
  ];
  const ordinary = [
    "process.env.FOO",
    "import.meta.env.X",
    "Object.keys(x)",
    "use item.key as the React key",
    "convert the certificate to .pem format",
    "the key file is rotated monthly",
    "environment variables",
    "a/b.keys",
    "the dotenv package",
    "/private/tmp/build",
    "Halbgeviertstrich als Gedankenstrich",
  ];

  test.each(keyMaterial)("flags %p", (text) => {
    expect(referencesKeyMaterialPath(text)).toBe(true);
  });

  test.each(ordinary)("leaves %p alone", (text) => {
    expect(referencesKeyMaterialPath(text)).toBe(false);
  });
});

describe("SSH private keys", () => {
  const openssh = generateSshKeyPair().private;
  const body = openssh.split("\n")[1] as string;

  test("scrubString hides an OpenSSH private key block", () => {
    const out = scrubString(`key was ${openssh} end`);
    expect(out).not.toContain(body);
    expect(out).not.toContain("BEGIN OPENSSH PRIVATE KEY");
    expect(out).toContain("end");
  });

  test("scrubSecrets hides a key nested in an object", () => {
    const out = JSON.stringify(scrubSecrets({ detail: { text: openssh } }));
    expect(out).not.toContain(body);
  });

  test("redact masks private_key and passphrase values but keeps vault item names", () => {
    const out = redact({
      auth: {
        method: "private_key",
        private_key: openssh,
        passphrase: "synthetic-passphrase",
        private_key_item: "sftp-deploy-key",
        passphrase_item: "sftp-deploy-key-passphrase",
      },
    }) as { auth: Record<string, unknown> };
    expect(JSON.stringify(out)).not.toContain(body);
    expect(JSON.stringify(out)).not.toContain("synthetic-passphrase");
    expect(out.auth.private_key_item).toBe("sftp-deploy-key");
    expect(out.auth.passphrase_item).toBe("sftp-deploy-key-passphrase");
  });
});
