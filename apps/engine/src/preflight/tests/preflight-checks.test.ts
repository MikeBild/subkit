// The six bootstrap-preflight checks, graded where they decide things.
//
// Three questions live here. The first is whether a refusal is a refusal:
// the contract promises exit 3 and ONE structured line, and a check that
// merely logged loudly and carried on would look identical in a passing
// suite. The second is whether the checks stop: once the release cannot run
// on this bootstrap, a later probe's failure is noise, and a probe that ran
// anyway would have touched something. The third is the contract's one
// deliberate non-refusal — a retired settings key is reported and ignored,
// and a release that refused on it would refuse to boot on its own history.

import { describe, expect, test } from "bun:test";
import { ConfigSchema } from "../../config/schema.ts";
import {
  identityFinding,
  type ObjectStoreBinding,
  type PreflightEnvironment,
  retiredSettingsKeys,
  runPreflightChecks,
  secretBindingsOf,
} from "../checks.ts";
import { firstRefusal, refusalLine } from "../contracts.ts";

const KEY = "a".repeat(64);
const DSN = "postgres://localhost/subkit";

/** The schema defaults plus the one required leaf. Every document test starts here. */
const base = () => ConfigSchema.parse({ database: { url: DSN } });

const BINDING: ObjectStoreBinding = {
  endpoint: "https://objects.example.invalid",
  region: "eu-central-1",
  bucket: "subkit",
  access_key_id: "id",
  secret_access_key: "secret",
  force_path_style: true,
};

/** A bootstrap on which every check passes. Each test breaks exactly one thing. */
function healthyEnvironment(overrides: Partial<PreflightEnvironment> = {}): {
  env: PreflightEnvironment;
  touched: string[];
} {
  const touched: string[] = [];
  const env: PreflightEnvironment = {
    masterKey: () => KEY,
    databaseUrl: () => DSN,
    pingDatabase: async () => {
      touched.push("pingDatabase");
    },
    schemaAheadTags: async () => {
      touched.push("schemaAheadTags");
      return [];
    },
    activeSettingsDocument: async () => {
      touched.push("activeSettingsDocument");
      return null;
    },
    objectStoreBinding: async () => {
      touched.push("objectStoreBinding");
      return BINDING;
    },
    probeObjectStore: async () => {
      touched.push("probeObjectStore");
    },
    readSecretVersion: async () => {
      touched.push("readSecretVersion");
    },
    ...overrides,
  };
  return { env, touched };
}

describe("the refusal itself", () => {
  test("a refusal is one JSON object with exactly event, code and detail", () => {
    const line = refusalLine({
      check: "object_store",
      ok: false,
      code: "object_store_missing",
      detail: "no binding",
    });
    expect(line).toBe(
      '{"event":"preflight.refused","code":"object_store_missing","detail":"no binding"}',
    );
    // One line, and parseable on its own — a deploy script reads it with
    // JSON.parse, not with a regex over prose.
    expect(line).not.toContain("\n");
    expect(Object.keys(JSON.parse(line))).toEqual(["event", "code", "detail"]);
  });
});

describe("check 1 — MASTER_KEY", () => {
  test("absent refuses with master_key_missing and probes nothing else", async () => {
    const { env, touched } = healthyEnvironment({ masterKey: () => undefined });
    const outcome = await runPreflightChecks(env);
    expect(outcome.refused).toBe(true);
    expect(firstRefusal(outcome)?.code).toBe("master_key_missing");
    // The contract's whole promise: a refusal has changed nothing. The
    // cheapest proof is that nothing downstream was even asked.
    expect(touched).toEqual([]);
  });

  test("a 63-character key refuses with master_key_malformed", async () => {
    const { env } = healthyEnvironment({ masterKey: () => "a".repeat(63) });
    const outcome = await runPreflightChecks(env);
    expect(firstRefusal(outcome)?.code).toBe("master_key_malformed");
  });

  test("a 64-character non-hex key refuses with master_key_malformed", async () => {
    const { env } = healthyEnvironment({ masterKey: () => "z".repeat(64) });
    const outcome = await runPreflightChecks(env);
    expect(firstRefusal(outcome)?.code).toBe("master_key_malformed");
  });
});

describe("check 2 — DATABASE_URL and the schema version", () => {
  test("an unreachable database refuses and never probes the object store", async () => {
    const { env, touched } = healthyEnvironment({
      pingDatabase: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    const outcome = await runPreflightChecks(env);
    expect(firstRefusal(outcome)?.code).toBe("database_unreachable");
    expect(firstRefusal(outcome)?.detail).toContain("ECONNREFUSED");
    expect(touched).not.toContain("probeObjectStore");
  });

  test("a schema newer than this release refuses with schema_ahead", async () => {
    const { env } = healthyEnvironment({ schemaAheadTags: async () => ["0099_from_the_future"] });
    const outcome = await runPreflightChecks(env);
    expect(firstRefusal(outcome)?.code).toBe("schema_ahead");
    expect(firstRefusal(outcome)?.detail).toContain("0099_from_the_future");
  });

  test("a virgin database — no tags ahead — passes and migrates forward", async () => {
    const { env } = healthyEnvironment();
    const outcome = await runPreflightChecks(env);
    expect(outcome.refused).toBe(false);
  });
});

describe("check 3 — the object store", () => {
  test("a release with no binding refuses BEFORE it migrates anything", async () => {
    const { env, touched } = healthyEnvironment({ objectStoreBinding: async () => null });
    const outcome = await runPreflightChecks(env);
    expect(firstRefusal(outcome)?.code).toBe("object_store_missing");
    expect(touched).not.toContain("probeObjectStore");
  });

  test("credentials that do not decrypt refuse as secret_unreadable, not as a bucket problem", async () => {
    // The stored block's credential leaves are secret:// references, so
    // resolving the binding is itself a decrypt. When that fails the cause
    // an operator must act on is the key — reporting object_store_missing
    // would send them to the wrong file.
    const { env, touched } = healthyEnvironment({
      objectStoreBinding: async () => {
        throw new Error("decrypt failed: unable to authenticate data");
      },
    });
    const outcome = await runPreflightChecks(env);
    const refusal = firstRefusal(outcome);
    expect(refusal?.code).toBe("secret_unreadable");
    expect(refusal?.detail).toContain("storage.object_store");
    expect(touched).not.toContain("probeObjectStore");
  });

  test("a binding that does not answer refuses with object_store_unreachable", async () => {
    const { env } = healthyEnvironment({
      probeObjectStore: async () => {
        throw new Error("NoSuchBucket");
      },
    });
    const outcome = await runPreflightChecks(env);
    expect(firstRefusal(outcome)?.code).toBe("object_store_unreachable");
    expect(firstRefusal(outcome)?.detail).toContain("NoSuchBucket");
  });
});

describe("check 4 — the current settings revision", () => {
  test("a retired key is reported and ignored, never a refusal", async () => {
    const document = {
      ...base(),
      llm_provider: "anthropic", // a key an older release persisted
      log: { level: "info", format: "json", retired_leaf: true },
    };
    const { env } = healthyEnvironment({ activeSettingsDocument: async () => document });
    const outcome = await runPreflightChecks(env);
    expect(outcome.refused).toBe(false);
    const note = outcome.notes.find((n) => n.action === "settings.retired_keys_dropped");
    expect(note).toBeDefined();
    expect(note?.detail).toContain("llm_provider");
    expect(note?.detail).toContain("log.retired_leaf");
  });

  test("a value the schema rejects refuses with settings_unparsable", async () => {
    const document = { ...base(), log: { level: "shout" } };
    const { env } = healthyEnvironment({ activeSettingsDocument: async () => document });
    const outcome = await runPreflightChecks(env);
    expect(firstRefusal(outcome)?.code).toBe("settings_unparsable");
    expect(firstRefusal(outcome)?.detail).toContain("log.level");
  });

  test("retiredSettingsKeys reports the retired section, not every key under it", () => {
    const dropped = retiredSettingsKeys({
      s3: { endpoint: "x", access_key: "y", secret_key: "z" },
      log: { level: "info" },
    });
    // Naming the section is the fact an operator acts on; listing its three
    // children would bury it.
    expect(dropped).toEqual(["s3"]);
  });

  test("a tenant overlay's retired key is reported with its tenant", () => {
    const dropped = retiredSettingsKeys({
      tenants: { "11111111-1111-1111-1111-111111111111": { llm: { provider_legacy: "x" } } },
    });
    expect(dropped).toEqual(["tenants.11111111-1111-1111-1111-111111111111.llm.provider_legacy"]);
  });
});

describe("check 5 — the secret versions the settings bind to", () => {
  test("an unreadable version refuses with its name and version", async () => {
    const document = {
      ...base(),
      llm: {
        ...base().llm,
        providers: {
          ...base().llm.providers,
          anthropic: {
            ...base().llm.providers.anthropic,
            api_key: "secret://settings.llm.providers.anthropic.api_key/3",
          },
        },
      },
    };
    const { env } = healthyEnvironment({
      activeSettingsDocument: async () => document,
      readSecretVersion: async () => {
        throw new Error("decrypt failed");
      },
    });
    const outcome = await runPreflightChecks(env);
    const refusal = firstRefusal(outcome);
    expect(refusal?.code).toBe("secret_unreadable");
    expect(refusal?.detail).toContain("settings.llm.providers.anthropic.api_key/3");
    // The BINDING path, so an operator knows what stops working, not just
    // which row is broken.
    expect(refusal?.detail).toContain("llm.providers.anthropic.api_key");
  });

  test("the same version bound twice is one thing to decrypt", () => {
    const bindings = secretBindingsOf({
      a: "secret://token/2",
      b: { c: "secret://token/2" },
      d: ["secret://other/1"],
    });
    expect(bindings.map((b) => `${b.name}/${b.version}`)).toEqual(["other/1", "token/2"]);
  });

  test("a version that decrypts is not a refusal", async () => {
    const document = { ...base(), spec: base().spec };
    const { env } = healthyEnvironment({ activeSettingsDocument: async () => document });
    const outcome = await runPreflightChecks(env);
    expect(outcome.refused).toBe(false);
  });
});

describe("check 6 — the identity provider", () => {
  test("a passing check emits the line the contract names", async () => {
    const { env } = healthyEnvironment();
    const outcome = await runPreflightChecks(env);
    const note = outcome.notes.find((n) => n.action === "identity.client_type");
    expect(note?.detail).toBe("public");
  });

  test("an http issuer outside localhost is malformed", () => {
    // Reached through the parsed config, because that is what the check
    // reads. The schema refines issuer_url too — this asserts the preflight
    // does not simply trust that a document reached it already refined.
    const finding = identityFinding({
      auth: {
        providers: [
          {
            protocol: "oidc",
            id: "idp",
            label: "IdP",
            issuer_url: "http://idp.example.invalid",
            client_id: "c",
            scopes: "openid",
            tenant_slug: "default",
          },
        ],
      },
    } as unknown as ReturnType<typeof ConfigSchema.parse>);
    expect(finding.ok).toBe(false);
    expect(finding.detail).toContain("is not https");
  });

  test("http on localhost is allowed — a developer's issuer is not a production risk", () => {
    const finding = identityFinding({
      auth: {
        providers: [
          {
            protocol: "oidc",
            id: "idp",
            label: "IdP",
            issuer_url: "http://localhost:8080",
            client_id: "c",
            scopes: "openid",
            tenant_slug: "default",
          },
        ],
      },
    } as unknown as ReturnType<typeof ConfigSchema.parse>);
    expect(finding.ok).toBe(true);
  });

  test("a client secret on an OIDC provider is malformed", () => {
    const finding = identityFinding({
      auth: {
        providers: [
          {
            protocol: "oidc",
            id: "idp",
            label: "IdP",
            issuer_url: "https://idp.example.invalid",
            client_id: "c",
            client_secret: "shhh",
            scopes: "openid",
            tenant_slug: "default",
          },
        ],
      },
    } as unknown as ReturnType<typeof ConfigSchema.parse>);
    expect(finding.ok).toBe(false);
    expect(finding.detail).toContain("PKCE");
  });
});

describe("T2 does not apply to SubKit — and this is the proof, not the claim", () => {
  test("an API key hash is a plain sha256 of the token, with no key material mixed in", async () => {
    const { createHash } = await import("node:crypto");
    const { hashKey } = await import("../../identity/api-key.ts");
    const token = "wf_live_0123456789abcdefghijklmnopqrstuv";
    const plain = createHash("sha256").update(token).digest("hex");
    // If a pepper — MASTER_KEY-derived or otherwise — were ever mixed into
    // the API-key hash, this equality breaks. Introducing one would then
    // invalidate every existing key, which is exactly the failure the
    // contract's "It never derives one secret from another" clause names.
    expect(hashKey(token)).toBe(plain);
  });

  test("the hash does not move when MASTER_KEY does", async () => {
    const { hashKey } = await import("../../identity/api-key.ts");
    const token = "wf_live_0123456789abcdefghijklmnopqrstuv";
    const before = hashKey(token);
    const original = process.env.MASTER_KEY;
    try {
      process.env.MASTER_KEY = "b".repeat(64);
      expect(hashKey(token)).toBe(before);
    } finally {
      if (original === undefined) delete process.env.MASTER_KEY;
      else process.env.MASTER_KEY = original;
    }
  });
});

describe("check 3 reads the credentials the engine will actually use", () => {
  // The regression this guards: every credential leaf of storage.object_store
  // is `meta.secret`, so a stored revision holds `secret://…` there, never a
  // usable value. A preflight that took those strings verbatim would probe
  // with the literal reference as an access key; one that treated them as
  // "incomplete" would fall through to OBJECT_STORAGE_*, which a stateless
  // deployment no longer sets — refusing a healthy engine, or passing on a
  // credential the engine does not use.
  const DOC = {
    storage: {
      object_store: {
        endpoint: "https://objects.example.invalid",
        region: "eu-central-1",
        bucket: "subkit",
        access_key_id: "secret://settings.storage.object_store.access_key_id/2",
        secret_access_key: "secret://settings.storage.object_store.secret_access_key/2",
        force_path_style: true,
      },
    },
  };

  test("secret:// references are decrypted, not passed through", async () => {
    const { objectStoreBindingFromDocument } = await import("../environment.ts");
    const asked: string[] = [];
    const binding = await objectStoreBindingFromDocument(DOC, async (name, version) => {
      asked.push(`${name}/${version}`);
      return name.endsWith("access_key_id") ? "AKIAREAL" : "realsecret";
    });
    expect(binding?.access_key_id).toBe("AKIAREAL");
    expect(binding?.secret_access_key).toBe("realsecret");
    expect(asked).toEqual([
      "settings.storage.object_store.access_key_id/2",
      "settings.storage.object_store.secret_access_key/2",
    ]);
  });

  test("a reference that does not decrypt propagates, so the caller can name the key", async () => {
    const { objectStoreBindingFromDocument } = await import("../environment.ts");
    await expect(
      objectStoreBindingFromDocument(DOC, async () => {
        throw new Error("decrypt failed");
      }),
    ).rejects.toThrow("decrypt failed");
  });

  test("a document with no object-store block is null, so the env seed can answer", async () => {
    const { objectStoreBindingFromDocument } = await import("../environment.ts");
    expect(await objectStoreBindingFromDocument({}, async () => "x")).toBeNull();
    expect(await objectStoreBindingFromDocument(null, async () => "x")).toBeNull();
  });
});
