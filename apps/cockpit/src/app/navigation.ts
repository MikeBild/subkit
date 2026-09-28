import {
  Activity,
  Bell,
  Boxes,
  Cable,
  FileStack,
  Gauge,
  History,
  KeyRound,
  Library,
  ListChecks,
  type LucideIcon,
  MessageSquare,
  Settings,
  ShieldCheck,
  Sparkles,
  Users,
  Workflow,
} from "lucide-react";
import type { TranslationKey } from "@/lib/i18n";

export interface NavigationItem {
  labelKey: TranslationKey;
  path: string;
  permission: string;
  /** Alternatives to `permission`: the entry shows when any one of them is granted. */
  anyPermissions?: readonly string[];
  icon: LucideIcon;
  api: readonly string[];
}

export interface NavigationGroup {
  id: "home" | "work" | "build" | "knowledge" | "admin";
  /** Absent where there must be no heading: Heute stands ungrouped, and a
   *  heading above it is a group whatever the table calls it. */
  labelKey?: TranslationKey;
  items: readonly NavigationItem[];
}

/**
 * What a reader of Heute may see: any one of the attention sources' read
 * permissions (operator/attention.ts, SOURCE_GATES). A person holding only a
 * grant on one workflow reads that workflow's entry, so the entry shows for
 * `workflow:read` as much as for `stats:read`.
 */
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
    // Heute stands alone, without a heading: it is the one place a task
    // lives, and a group around it would make it one list among several.
    id: "home",
    items: [
      {
        labelKey: "nav.today",
        path: "/",
        permission: "stats:read",
        anyPermissions: ATTENTION_READ_PERMISSIONS,
        icon: ListChecks,
        // The review sheet resolves an entry's decisions through the reads
        // the decision cards have always used.
        api: [
          "GET /v1/attention",
          "GET /v1/patch-candidates",
          "GET /v1/skill-candidates",
          "GET /v1/schedules",
        ],
      },
    ],
  },
  {
    id: "work",
    labelKey: "nav.group.work",
    items: [
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
        // The connector read is the slug→id index the connector chips need.
        api: ["GET /v1/workflows", "GET /v1/connectors"],
      },
      {
        labelKey: "nav.runs",
        path: "/runs",
        permission: "execution:read",
        icon: Activity,
        api: ["GET /v1/executions"],
      },
      {
        labelKey: "nav.connectors",
        path: "/connectors",
        permission: "connector:read",
        icon: Cable,
        // The workflow read is inverted into the "used by" relation.
        api: ["GET /v1/connectors", "GET /v1/workflows"],
      },
    ],
  },
  {
    id: "knowledge",
    labelKey: "nav.group.knowledge",
    items: [
      {
        labelKey: "nav.knowledge",
        path: "/knowledge",
        permission: "knowledge:read",
        icon: Library,
        api: ["GET /v1/knowledge-sources"],
      },
      {
        labelKey: "nav.skills",
        path: "/skills",
        permission: "skill:read",
        icon: Sparkles,
        api: ["GET /v1/skills"],
      },
      {
        labelKey: "nav.files",
        path: "/files",
        permission: "file:read",
        icon: FileStack,
        api: ["GET /v1/files"],
      },
    ],
  },
  {
    // "Installation": how it runs and what it costs, how it is configured, who
    // may do what, what is announced, and what happened. There is no System
    // entry any more — the health state is one line on Heute when nothing is
    // open, and every cause of an unwell installation is an entry there.
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
        labelKey: "nav.settings",
        path: "/settings",
        permission: "settings:read",
        icon: Settings,
        api: ["GET /v1/settings"],
      },
      {
        // The one page for everything that holds or grants rights: API keys,
        // connected applications, account connections — each section behind
        // its own read permission, so the entry shows for any of them.
        labelKey: "nav.apiAccess",
        path: "/api-access",
        permission: "api_key:read",
        anyPermissions: ["api_key:read", "mcp_oauth_client:read", "connection:read"],
        icon: KeyRound,
        api: ["GET /v1/identity/api-keys", "GET /v1/oauth/clients", "GET /v1/connections"],
      },
      {
        labelKey: "nav.people",
        path: "/people",
        permission: "identity:read",
        icon: Users,
        api: ["GET /v1/identity/users"],
      },
      {
        labelKey: "nav.access",
        path: "/access",
        permission: "rbac:read",
        icon: ShieldCheck,
        api: ["GET /v1/rbac/roles"],
      },
      {
        labelKey: "nav.notifications",
        path: "/notifications",
        permission: "notification:read",
        icon: Bell,
        api: ["GET /v1/notifications/rules", "GET /v1/notifications/channels"],
      },
      {
        labelKey: "nav.audit",
        path: "/audit",
        permission: "audit:read",
        icon: History,
        api: ["GET /v1/audit-log"],
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
  return NAVIGATION.flatMap((group) => group.items).find((item) =>
    item.path === "/"
      ? pathname === "/"
      : pathname === item.path || pathname.startsWith(`${item.path}/`),
  );
}
