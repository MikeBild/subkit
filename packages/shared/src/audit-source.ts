export const AUDIT_SOURCE_HEADER = "x-subkit-audit-source" as const;

export const DEPLOY_VERSION_HEADER = "x-subkit-deploy-version" as const;

export const AUDIT_SOURCE_VALUES = ["sk_cli", "deploy_bootstrap"] as const;
export type AuditSource = (typeof AUDIT_SOURCE_VALUES)[number];
