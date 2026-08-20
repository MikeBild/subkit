import {
  Activity,
  Bell,
  Boxes,
  Cable,
  Cpu,
  FileStack,
  Gauge,
  History,
  Inbox,
  KeyRound,
  LayoutDashboard,
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
  /** Absent where the convention forbids a heading: the overview and the
   *  decisions entry stand ungrouped (§8.1), and a heading above them is a
   *  group whatever the table calls it. */
  labelKey?: TranslationKey;
  items: readonly NavigationItem[];
}

export const NAVIGATION: readonly NavigationGroup[] = [
  {
    id: "home",
    items: [
      {
        labelKey: "nav.overview",
        path: "/overview",
        permission: "stats:read",
        icon: LayoutDashboard,
        // The recent-runs block is gated separately on `execution:read`, which
        // `stats:read` does not imply.
        api: ["GET /v1/operator/health-digest", "GET /v1/executions"],
      },
      {
        labelKey: "nav.decisions",
        path: "/decisions",
        permission: "workflow:read",
        anyPermissions: ["workflow:read", "skill:read", "conversation:list", "conversation:read"],
        icon: ListChecks,
        // The last two resolve a decision's target to a NAME. Without them a
        // card can only show an id, and ids are banned from every surface.
        api: [
          "GET /v1/patch-candidates",
          "GET /v1/skill-candidates",
          "GET /v1/conversations",
          "GET /v1/workflows",
          "GET /v1/connectors",
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
      {
        labelKey: "nav.inbox",
        path: "/inbox",
        permission: "notification:read",
        icon: Inbox,
        api: ["GET /v1/notifications/inbox"],
      },
    ],
  },
  {
    id: "build",
    labelKey: "nav.group.build",
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
    // §6: the shared admin block is called "Installation" in all six products,
    // and it carries the same five entries — System, Einstellungen,
    // Zugangsdaten, Benachrichtigungen, Audit — before anything this product
    // adds. Audit moved here from a group of its own: a section that has to
    // contain it cannot also leave it somewhere else.
    id: "admin",
    labelKey: "nav.group.admin",
    items: [
      {
        labelKey: "nav.operations",
        path: "/operations",
        permission: "stats:read",
        icon: Cpu,
        api: ["GET /v1/operator/health-digest"],
      },
      {
        labelKey: "nav.settings",
        path: "/settings",
        permission: "settings:read",
        icon: Settings,
        api: ["GET /v1/settings"],
      },
      {
        labelKey: "nav.apiAccess",
        path: "/api-access",
        permission: "api_key:read",
        icon: KeyRound,
        api: ["GET /v1/identity/api-keys"],
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
        labelKey: "nav.usage",
        path: "/usage",
        permission: "stats:read",
        icon: Gauge,
        api: ["GET /v1/stats/executions"],
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
  return NAVIGATION.flatMap((group) => group.items).find((item) => pathname.startsWith(item.path));
}
