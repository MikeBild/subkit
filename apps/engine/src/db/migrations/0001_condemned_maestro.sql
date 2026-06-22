ALTER TABLE "conversations" ADD COLUMN "turn_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE "conversations" SET "loaded_skills" = COALESCE((SELECT jsonb_agg(jsonb_build_object('slug', elem, 'last_turn', 0)) FROM jsonb_array_elements_text("loaded_skills") AS elem), '[]'::jsonb) WHERE jsonb_typeof("loaded_skills") = 'array' AND jsonb_array_length("loaded_skills") > 0 AND jsonb_typeof("loaded_skills"->0) = 'string';
