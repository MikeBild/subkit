ALTER TYPE "public"."credential_mode" ADD VALUE 'oauth2_private_key';--> statement-breakpoint
ALTER TABLE "mcp_servers" DROP CONSTRAINT "mcp_servers_auth_config_no_inline_secrets_check";--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_auth_config_no_inline_secrets_check" CHECK ("mcp_servers"."auth_config" IS NULL OR NOT (
        "mcp_servers"."auth_config" ? 'client_secret' OR
        "mcp_servers"."auth_config" ? 'password' OR
        "mcp_servers"."auth_config" ? 'passphrase' OR
        "mcp_servers"."auth_config" ? 'api_key' OR
        "mcp_servers"."auth_config" ? 'apikey' OR
        "mcp_servers"."auth_config" ? 'access_token' OR
        "mcp_servers"."auth_config" ? 'refresh_token' OR
        "mcp_servers"."auth_config" ? 'bearer_token' OR
        "mcp_servers"."auth_config" ? 'secret' OR
        "mcp_servers"."auth_config" ? 'private_key'
      ));
