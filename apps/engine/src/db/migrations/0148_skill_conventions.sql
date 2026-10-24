ALTER TABLE "skills" ADD COLUMN "rules" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "domains" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_rules_array_chk" CHECK (jsonb_typeof("skills"."rules") = 'array');--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_domains_array_chk" CHECK (jsonb_typeof("skills"."domains") = 'array');--> statement-breakpoint
UPDATE "skills" AS s SET "domains" = derived.domains
FROM (
	SELECT t.id, to_jsonb(array_agg(t.domain ORDER BY t.domain)) AS domains
	FROM (
		SELECT DISTINCT k.id, lower(btrim(substr(tag.value, 8))) AS domain
		FROM "skills" AS k, jsonb_array_elements_text(CASE WHEN jsonb_typeof(k."tags") = 'array' THEN k."tags" ELSE '[]'::jsonb END) AS tag(value)
		WHERE tag.value LIKE 'domain:%'
	) AS t
	WHERE t.domain ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(t.domain) <= 40
	GROUP BY t.id
) AS derived
WHERE s.id = derived.id;
