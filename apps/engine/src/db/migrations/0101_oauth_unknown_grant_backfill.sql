INSERT INTO "mcp_oauth_unknown_grants" ("tenant_id", "client_id")
SELECT DISTINCT "tenant_id", "client_id"
FROM (
  SELECT "tenant_id", "client_id"
  FROM "mcp_oauth_access_tokens"
  WHERE "grant_id" IS NULL
  UNION
  SELECT "tenant_id", "client_id"
  FROM "mcp_oauth_refresh_tokens"
  WHERE "grant_id" IS NULL
) AS historical_oauth_tokens
ON CONFLICT ("tenant_id", "client_id") DO NOTHING;
