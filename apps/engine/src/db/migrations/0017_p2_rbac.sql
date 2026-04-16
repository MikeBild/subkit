-- Pass 2 C1: fully integrated RBAC.
--
-- Introduces the permission catalog, roles table, role↔permission
-- mapping, resource grants, groups, group members, and group↔role
-- assignments. The `users.role` enum column is kept in place; a new
-- `users.role_id` nullable FK is added and populated by the seed step.
-- System accounts get a matching `role_id` column so machine tokens
-- stop inheriting hardcoded `admin` roles.

CREATE TABLE IF NOT EXISTS "permissions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" text NOT NULL,
  "description" text,
  "resource_type" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "permissions_name_key" ON "permissions" ("name");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "roles" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid REFERENCES "tenants"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "description" text,
  "is_builtin" boolean NOT NULL DEFAULT false,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "roles_tenant_name_key"
  ON "roles" ("tenant_id", "name");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "role_permissions" (
  "role_id" uuid NOT NULL REFERENCES "roles"("id") ON DELETE CASCADE,
  "permission_id" uuid NOT NULL REFERENCES "permissions"("id") ON DELETE CASCADE,
  PRIMARY KEY ("role_id", "permission_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "role_permissions_role_idx" ON "role_permissions" ("role_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "role_permissions_permission_idx"
  ON "role_permissions" ("permission_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "resource_grants" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "subject_type" text NOT NULL,
  "subject_id" uuid NOT NULL,
  "resource_type" text NOT NULL,
  "resource_id" uuid NOT NULL,
  "permission_id" uuid NOT NULL REFERENCES "permissions"("id") ON DELETE CASCADE,
  "granted_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone,
  CONSTRAINT "resource_grants_subject_type_chk"
    CHECK ("subject_type" IN ('user','system_account','group'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "resource_grants_unique_key"
  ON "resource_grants" (
    "tenant_id", "subject_type", "subject_id",
    "resource_type", "resource_id", "permission_id"
  );
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "resource_grants_subject_idx"
  ON "resource_grants" ("tenant_id", "subject_type", "subject_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "resource_grants_resource_idx"
  ON "resource_grants" ("tenant_id", "resource_type", "resource_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "groups" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "description" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "groups_tenant_name_key"
  ON "groups" ("tenant_id", "name");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "group_members" (
  "group_id" uuid NOT NULL REFERENCES "groups"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL,
  "added_by" uuid,
  "added_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("group_id", "user_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "group_members_user_idx" ON "group_members" ("user_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "group_role_assignments" (
  "group_id" uuid NOT NULL REFERENCES "groups"("id") ON DELETE CASCADE,
  "role_id" uuid NOT NULL REFERENCES "roles"("id") ON DELETE CASCADE,
  PRIMARY KEY ("group_id", "role_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "group_role_assignments_role_idx"
  ON "group_role_assignments" ("role_id");
--> statement-breakpoint

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "role_id" uuid REFERENCES "roles"("id");
--> statement-breakpoint
ALTER TABLE "system_accounts"
  ADD COLUMN IF NOT EXISTS "role_id" uuid REFERENCES "roles"("id");
