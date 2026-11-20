import { type ConfigLeaf, dottedPath, listConfigLeaves } from "../walk.ts";

export function configurationSweepLeaves(): ConfigLeaf[] {
  const activation = (leaf: ConfigLeaf) => {
    const path = dottedPath(leaf);
    if (path === "auth.hosted.registration_enabled") return 2;
    return Number(path === "auth.hosted.enabled");
  };
  return listConfigLeaves().sort((left, right) => activation(left) - activation(right));
}

export function sampleConfigLeaf(leaf: ConfigLeaf, salt: number): unknown {
  const path = dottedPath(leaf);
  const tag = `sample-${path.replaceAll(".", "-")}-${salt}`;
  let candidates: unknown[];
  switch (leaf.kind) {
    case "string":
      candidates = [
        tag,
        `https://example.test/${tag}`,
        tag.padEnd(32, "x").slice(0, 32),
        "00:00",
        "1.2.3",
        "1",
        "0",
        "",
      ];
      break;
    case "number": {
      const fixed: Record<string, number> = {
        "server.hosted_rate_limit.tenant_per_month": 100_000,
        "server.hosted_rate_limit.principal_per_minute": 100_000,
        "server.hosted_rate_limit.peer_per_minute": 100_000,
        "server.hosted_rate_limit.tenant_per_minute": 100_000,
        "server.hosted_rate_limit.global_per_minute": 100_000,
        "sandbox.queue_limit": 64,
        "sandbox.tenant_queue_limit": 4,
        "sandbox.ipc_max_bytes": 1024 * 1024,
        "sandbox.worker_rss_bytes": 256 * 1024 * 1024,
      };
      candidates =
        path in fixed
          ? [fixed[path]]
          : [((salt + 5) % 45) + 5, 1, 0, 0.5, 200, 1000, 60_000, 100_000, 3_600_000];
      break;
    }
    case "boolean":
      candidates = [true];
      break;
    case "enum": {
      const values = leaf.enumValues ?? [];
      candidates = values.length > 1 ? [values[1 + (salt % (values.length - 1))]] : values;
      break;
    }
    case "string-list":
    case "string-array":
      candidates = [[tag], ["127.0.0.1"], []];
      break;
    case "json": {
      const samples: Record<string, unknown> = {
        "auth.providers": [
          { protocol: "api_key", id: "api-key", label: "SubKit API key" },
          {
            protocol: "oidc",
            id: `oidc-${salt}`,
            label: "Public OIDC",
            issuer_url: "https://identity.example.test",
            client_id: `client-${salt}`,
            scopes: "openid profile email",
            tenant_slug: "default",
          },
        ],
        products: {
          sample: {
            execution_environment: "prod",
            assistant_workflow_id: "00000000-0000-4000-8000-000000000001",
            budget_bucket: "sample",
          },
        },
        "tokens.prices": [
          {
            model: tag,
            input_per_mtok: 3,
            output_per_mtok: 15,
            cache_read_per_mtok: 0.3,
            cache_write_per_mtok: 3.75,
          },
        ],
      };
      if (!(path in samples)) throw new Error(`no structural sample for ${path}`);
      candidates = [samples[path]];
      break;
    }
  }
  for (const candidate of candidates) {
    if (leaf.schema.safeParse(candidate).success) return candidate;
  }
  throw new Error(`no valid sample for ${path}`);
}
