import {
  BookOpen,
  Boxes,
  Cable,
  FileText,
  Gauge,
  History,
  KeyRound,
  ListChecks,
  type LucideIcon,
  MessageSquare,
  Settings,
  Sparkles,
  Users,
  Workflow,
} from "lucide-react";
import type { TranslationKey } from "@/lib/i18n";

export interface NavigationItem {
  labelKey: TranslationKey;
  path: string;
  permission: string;
  anyPermissions?: readonly string[];
  icon: LucideIcon;
  api: readonly string[];
}

export interface NavigationGroup {
  id: "home" | "build" | "knowledge" | "admin";
  labelKey?: TranslationKey;
  items: readonly NavigationItem[];
}

export const ATTENTION_READ_PERMISSIONS = [
  "conversation:read",
  "workflow:read",
  "stats:read",
  "connector:read",
  "connection:read",
  "settings:read",
  "skill:read",
] as const;

export const NAVIGATION: readonly NavigationGroup[] = [
  {
    id: "home",
    items: [
      {
        labelKey: "nav.overview",
        path: "/",
        permission: "stats:read",
        anyPermissions: ATTENTION_READ_PERMISSIONS,
        icon: ListChecks,
        api: [
          "GET /v1/attention",
          "GET /v1/patch-candidates",
          "GET /v1/skill-candidates",
          "GET /v1/schedules",
          "GET /v1/executions",
        ],
      },
      {
        labelKey: "nav.chat",
        path: "/chat",
        permission: "conversation:read",
        icon: MessageSquare,
        api: ["GET /v1/conversations"],
      },
    ],
  },
  {
    id: "build",
    labelKey: "nav.group.automation",
    items: [
      {
        labelKey: "nav.workflows",
        path: "/workflows",
        permission: "workflow:read",
        icon: Workflow,
        api: ["GET /v1/workflows", "GET /v1/connectors"],
      },
      {
        labelKey: "nav.connectors",
        path: "/connectors",
        permission: "connector:read",
        icon: Cable,
        api: ["GET /v1/connectors", "GET /v1/workflows"],
      },
    ],
  },
  {
    id: "knowledge",
    labelKey: "nav.group.knowledge",
    items: [
      {
        labelKey: "nav.knowledgeSources",
        path: "/knowledge",
        permission: "knowledge:read",
        icon: BookOpen,
        api: ["GET /v1/knowledge-sources"],
      },
      {
        labelKey: "nav.skills",
        path: "/skills",
        permission: "skill:read",
        icon: Sparkles,
        api: ["GET /v1/skills", "GET /v1/skill-candidates"],
      },
      {
        labelKey: "nav.files",
        path: "/files",
        permission: "file:read",
        icon: FileText,
        api: ["GET /v1/files"],
      },
    ],
  },
  {
    id: "admin",
    labelKey: "nav.group.admin",
    items: [
      {
        labelKey: "nav.usage",
        path: "/usage",
        permission: "stats:read",
        icon: Gauge,
        api: ["GET /v1/stats/executions"],
      },
      {
        labelKey: "nav.audit",
        path: "/audit",
        permission: "audit:read",
        icon: History,
        api: ["GET /v1/audit-log"],
      },
      {
        labelKey: "nav.people",
        path: "/people",
        permission: "identity:read",
        anyPermissions: ["identity:read", "rbac:read"],
        icon: Users,
        api: ["GET /v1/identity/users", "GET /v1/rbac/roles"],
      },
      {
        labelKey: "nav.apiAccess",
        path: "/api-access",
        permission: "api_key:read",
        anyPermissions: ["api_key:read", "mcp_oauth_client:read", "connection:read"],
        icon: KeyRound,
        api: ["GET /v1/identity/api-keys", "GET /v1/oauth/clients", "GET /v1/connections"],
      },
      {
        labelKey: "nav.settings",
        path: "/settings",
        permission: "settings:read",
        anyPermissions: ["settings:read", "notification:read"],
        icon: Settings,
        api: ["GET /v1/settings", "GET /v1/notifications/rules", "GET /v1/notifications/channels"],
      },
    ],
  },
] as const;

export const ALL_PRODUCTS_ICON = Boxes;

export function visibleNavigation(permissions: readonly string[]): NavigationGroup[] {
  const allowed = new Set(permissions);
  return NAVIGATION.map((group) => ({
    ...group,
    items: group.items.filter((item) =>
      item.anyPermissions
        ? item.anyPermissions.some((permission) => allowed.has(permission))
        : allowed.has(item.permission),
    ),
  })).filter((group) => group.items.length > 0);
}

export function navigationItem(pathname: string): NavigationItem | undefined {
  const under = (path: string) => pathname === path || pathname.startsWith(`${path}/`);
  return NAVIGATION.flatMap((group) => group.items).find((item) =>
    item.path === "/" ? pathname === "/" : under(item.path),
  );
}
