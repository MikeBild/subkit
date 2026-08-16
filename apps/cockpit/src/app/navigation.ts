import {
  Activity,
  Bot,
  Boxes,
  Cable,
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
  icon: LucideIcon;
  api: readonly string[];
}

export interface NavigationGroup {
  id: "home" | "work" | "build" | "knowledge" | "govern" | "admin";
  labelKey: TranslationKey;
  items: readonly NavigationItem[];
}

export const NAVIGATION: readonly NavigationGroup[] = [
  {
    id: "home",
    labelKey: "nav.group.home",
    items: [
      {
        labelKey: "nav.overview",
        path: "/overview",
        permission: "stats:read",
        icon: LayoutDashboard,
        api: ["GET /v1/operator/health-digest"],
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
        api: ["GET /v1/workflows"],
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
        api: ["GET /v1/connectors"],
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
    id: "govern",
    labelKey: "nav.group.govern",
    items: [
      {
        labelKey: "nav.approvals",
        path: "/approvals",
        permission: "conversation:approve",
        icon: ListChecks,
        api: ["GET /v1/skill-candidates", "GET /v1/patch-candidates"],
      },
      {
        labelKey: "nav.audit",
        path: "/audit",
        permission: "audit:read",
        icon: History,
        api: ["GET /v1/audit-log"],
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
  {
    id: "admin",
    labelKey: "nav.group.admin",
    items: [
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
        labelKey: "nav.apiAccess",
        path: "/api-access",
        permission: "api_key:read",
        icon: KeyRound,
        api: ["GET /v1/identity/api-keys"],
      },
      {
        labelKey: "nav.operations",
        path: "/operations",
        permission: "stats:read",
        icon: Bot,
        api: ["GET /v1/operator/health-digest"],
      },
      {
        labelKey: "nav.settings",
        path: "/settings",
        permission: "settings:read",
        icon: Settings,
        api: ["GET /v1/settings"],
      },
    ],
  },
] as const;

export const ALL_PRODUCTS_ICON = Boxes;

export function visibleNavigation(permissions: readonly string[]): NavigationGroup[] {
  const allowed = new Set(permissions);
  return NAVIGATION.map((group) => ({
    ...group,
    items: group.items.filter((item) => allowed.has(item.permission)),
  })).filter((group) => group.items.length > 0);
}

export function navigationItem(pathname: string): NavigationItem | undefined {
  return NAVIGATION.flatMap((group) => group.items).find((item) => pathname.startsWith(item.path));
}
