-- Consolidate repeated observations, preserving the earliest evidence and audit history.
WITH ranked AS (
  SELECT e.id, e.skill_candidate_id,
    row_number() OVER (
      PARTITION BY e.skill_candidate_id, e.evidence_type,
        coalesce(e.execution_id::text, ''), coalesce(e.patch_candidate_id::text, ''),
        CASE WHEN e.execution_id IS NULL AND e.patch_candidate_id IS NULL THEN e.summary ELSE '' END
      ORDER BY e.captured_at, e.id
    ) AS occurrence
  FROM subkit.skill_candidate_evidence e
), removed AS (
  DELETE FROM subkit.skill_candidate_evidence e USING ranked r
  WHERE e.id = r.id AND r.occurrence > 1
  RETURNING e.skill_candidate_id
)
INSERT INTO subkit.audit_log (id, tenant_id, actor_type, action, resource_type, resource_id, result, reason, metadata)
SELECT gen_random_uuid(), c.tenant_id, 'system', 'skill_candidate.evidence_consolidated',
  'skill_candidate', c.id::text, 'success', 'Repeated references to the same observation were consolidated',
  jsonb_build_object('duplicates_removed', count(*), 'request_source', 'migration')
FROM removed r JOIN subkit.skill_candidates c ON c.id = r.skill_candidate_id
GROUP BY c.tenant_id, c.id;
