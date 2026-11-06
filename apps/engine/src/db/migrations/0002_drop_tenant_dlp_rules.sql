DO $$
BEGIN
 IF to_regclass('subkit.tenant_dlp_rules') IS NOT NULL THEN
  UPDATE subkit.hosted_tenant_usage u SET logical_bytes=u.logical_bytes-s.bytes FROM (SELECT r.tenant_id AS tenant_id,COALESCE(sum(COALESCE(octet_length(convert_to(r."path_match"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."pattern_regex"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."action"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."reason"::text,'UTF8')),0)::bigint),0)::bigint AS bytes FROM subkit."tenant_dlp_rules" r JOIN subkit.tenants t ON t.id=r.tenant_id AND t.origin='self_service' GROUP BY r.tenant_id) s WHERE u.tenant_id=s.tenant_id;
 END IF;
END $$;
--> statement-breakpoint
UPDATE subkit.hosted_tenant_usage SET resource_counts=resource_counts-'tenant_dlp_rules' WHERE resource_counts ? 'tenant_dlp_rules';
--> statement-breakpoint
DROP TABLE IF EXISTS subkit."tenant_dlp_rules" CASCADE;
--> statement-breakpoint
DROP FUNCTION IF EXISTS subkit.hosted_meter_tenant_dlp_rules();
