WITH removed AS (
  DELETE FROM subkit.cockpit_push_subscriptions p USING subkit.sessions s
  WHERE s.id = p.session_id
    AND s.tenant_id = p.tenant_id
    AND s.revoked_at IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM subkit.audit_log a
      WHERE a.tenant_id = p.tenant_id
        AND a.action = 'session.revoked'
        AND a.resource_type = 'session'
        AND a.resource_id = s.id::text
        AND a.reason IN ('expired_absolute', 'expired_sliding')
    )
  RETURNING p.tenant_id, p.installation_id
)
INSERT INTO subkit.audit_log (id, tenant_id, actor_type, action, resource_type, resource_id, result, reason, metadata)
SELECT gen_random_uuid(), r.tenant_id, 'system', 'cockpit_push.subscription_removed',
  'cockpit_push_subscription', r.tenant_id::text, 'success', 'session_revoked',
  jsonb_build_object(
    'count', count(*),
    'installation_ids', jsonb_agg(DISTINCT r.installation_id ORDER BY r.installation_id),
    'request_source', 'migration'
  )
FROM removed r
GROUP BY r.tenant_id;
