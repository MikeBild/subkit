ALTER TABLE "api_keys" ADD COLUMN "credential_origin" text;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_credential_origin_check" CHECK ("api_keys"."credential_origin" is null or "api_keys"."credential_origin" = 'cli_oauth_session');--> statement-breakpoint
CREATE FUNCTION subkit.api_key_credential_origin_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.credential_origin IS DISTINCT FROM NEW.credential_origin THEN
    RAISE EXCEPTION 'api_key_credential_origin_immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER api_key_credential_origin_guard BEFORE UPDATE OF credential_origin ON subkit.api_keys FOR EACH ROW EXECUTE FUNCTION subkit.api_key_credential_origin_immutable();
