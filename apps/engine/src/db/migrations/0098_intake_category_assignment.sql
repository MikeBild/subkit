INSERT INTO catalog_categories (tenant_id, name, purpose_pending)
SELECT DISTINCT tenant_id, category, false FROM intake_items
WHERE category NOT IN ('other', 'platform')
ON CONFLICT DO NOTHING;
--> statement-breakpoint
CREATE TRIGGER catalog_category_assignment BEFORE INSERT OR UPDATE ON intake_items FOR EACH ROW EXECUTE FUNCTION catalog_category_assignment();
--> statement-breakpoint
CREATE TRIGGER catalog_category_assignment BEFORE INSERT OR UPDATE ON intake_category_defaults FOR EACH ROW EXECUTE FUNCTION catalog_category_assignment();
