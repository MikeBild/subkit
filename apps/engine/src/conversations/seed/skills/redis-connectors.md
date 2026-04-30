---
slug: redis-connectors
scope: global
title: Redis Connectors
description: Driver specifics for Redis — connection URL, GET/SET/DEL/PUBLISH operations.
gates_tools: []
version: 1
---

# Redis Connectors

The `redis` driver wraps `node-redis`. Each step issues one command and
returns the result as the envelope's `data`. Use it for caching,
pub/sub fan-out, rate-limit counters — not for primary durable storage.

## Connection URL

```
redis://${cred.cache.username}:${cred.cache.password}@${connector.cache.config.host}:6379/0
```

`rediss://` for TLS. The trailing `/0` selects database index 0 (Redis
default). Use a separate connector per database index when isolation
matters.

## Step shape

The `request` step's `redis` block carries `op` + arguments:

```json
{
  "id": "cache_user",
  "kind": "request",
  "connector_id": "<cache>",
  "redis": {
    "op": "SET",
    "key": "user:${input.user_id}",
    "value": "${scope.fetch_user.data}",
    "ex_seconds": 3600
  }
}
```

Supported `op` values: `GET`, `SET`, `DEL`, `EXISTS`, `INCR`, `EXPIRE`,
`PUBLISH`. SUBSCRIBE is intentionally not supported in the request-step
model — use a webhook or a dedicated worker.

## Common pitfalls

- **Treating Redis as durable.** `maxmemory-policy: allkeys-lru` evicts
  silently. Don't rely on a SET surviving a memory spike.
- **Large values.** Redis stores strings, but values >100KB hurt latency.
  Keep cached payloads small; for big blobs use S3.
- **PUB on a key nobody SUBSCRIBES to.** Returns 0 receivers — not an
  error. Check the count if delivery matters.

## See also

- `subkit-concepts.md` — envelope shape for Redis responses.
