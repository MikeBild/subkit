CREATE OR REPLACE FUNCTION subkit.catalog_category_assignment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  current_name text;
  next_name text;
  visited text[] := ARRAY[]::text[];
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.tenant_id IS NOT DISTINCT FROM OLD.tenant_id AND NEW.category IS NOT DISTINCT FROM OLD.category THEN
    RETURN NEW;
  END IF;
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
