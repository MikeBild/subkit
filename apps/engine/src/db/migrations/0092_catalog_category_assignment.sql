INSERT INTO catalog_categories (tenant_id, name, purpose_pending)
SELECT DISTINCT tenant_id, category, false FROM (
  SELECT tenant_id, category FROM workflows
  UNION ALL SELECT tenant_id, category FROM connectors
  UNION ALL SELECT tenant_id, category FROM knowledge_sources
  UNION ALL SELECT tenant_id, category FROM skills
  UNION ALL SELECT tenant_id, category FROM files
) categories WHERE category NOT IN ('other', 'platform')
ON CONFLICT DO NOTHING;
--> statement-breakpoint
CREATE FUNCTION catalog_category_assignment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  current_name text;
  next_name text;
  visited text[] := ARRAY[]::text[];
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtextextended(NEW.tenant_id::text, 741937)) THEN
    RAISE EXCEPTION 'Catalog vocabulary changed concurrently; retry the operation' USING ERRCODE = '40001';
  END IF;
  current_name := NEW.category;
  LOOP
    IF current_name = ANY(visited) OR cardinality(visited) >= 64 THEN
      RAISE EXCEPTION 'Catalog category redirect cycle' USING ERRCODE = '23514';
    END IF;
    visited := array_append(visited, current_name);
    SELECT redirect_to INTO next_name FROM catalog_categories
      WHERE tenant_id = NEW.tenant_id AND name = current_name;
    EXIT WHEN next_name IS NULL;
    current_name := next_name;
  END LOOP;
  IF current_name NOT IN ('other', 'platform') THEN
    INSERT INTO catalog_categories (tenant_id, name, purpose_pending)
      VALUES (NEW.tenant_id, current_name, true) ON CONFLICT DO NOTHING;
  END IF;
  NEW.category := current_name;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER catalog_category_assignment BEFORE INSERT OR UPDATE ON workflows FOR EACH ROW EXECUTE FUNCTION catalog_category_assignment();
--> statement-breakpoint
CREATE TRIGGER catalog_category_assignment BEFORE INSERT OR UPDATE ON connectors FOR EACH ROW EXECUTE FUNCTION catalog_category_assignment();
--> statement-breakpoint
CREATE TRIGGER catalog_category_assignment BEFORE INSERT OR UPDATE ON knowledge_sources FOR EACH ROW EXECUTE FUNCTION catalog_category_assignment();
--> statement-breakpoint
CREATE TRIGGER catalog_category_assignment BEFORE INSERT OR UPDATE ON skills FOR EACH ROW EXECUTE FUNCTION catalog_category_assignment();
--> statement-breakpoint
CREATE TRIGGER catalog_category_assignment BEFORE INSERT OR UPDATE ON files FOR EACH ROW EXECUTE FUNCTION catalog_category_assignment();
