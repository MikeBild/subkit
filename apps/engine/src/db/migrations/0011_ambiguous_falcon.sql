ALTER TABLE "connectors" ADD COLUMN "self_description" jsonb DEFAULT '{}'::jsonb NOT NULL;
