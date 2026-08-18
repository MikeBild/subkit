import { createRootRoute, createRoute, createRouter, Navigate } from "@tanstack/react-router";
import { AccessPage, ApiAccessPage, OperationsPage, PeoplePage, SettingsPage } from "@/pages/admin";
import { AuditPage } from "@/pages/audit";
import { CATALOG_RESOURCES, CatalogPage } from "@/pages/catalog";
import { CatalogDetailPage, type DetailResource } from "@/pages/catalog-detail";
import { ChatPage } from "@/pages/chat";
import { DecisionsPage } from "@/pages/decisions";
import { InboxPage } from "@/pages/inbox";
import { OverviewPage } from "@/pages/overview";
import { RunsPage } from "@/pages/runs";
import { UsagePage } from "@/pages/usage";
import { useSession } from "./session";
import { AppShell } from "./shell";

const rootRoute = createRootRoute({ component: AppShell });

// Session permissions live behind React context, so the landing choice is a
// rendered client-side redirect instead of a beforeLoad decision.
function IndexRedirect() {
  const session = useSession();
  return (
    <Navigate to={session.permissions.includes("stats:read") ? "/overview" : "/chat"} replace />
  );
}

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: IndexRedirect,
});
const chatRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/chat",
  component: ChatPage,
});
const newChatRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/chat/new",
  component: ChatPage,
});
const conversationRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/chat/$conversationId",
  component: ChatPage,
});

// Every page is its own module (CUI-PAGE-2). There is no generic resource
// renderer any more: a list that cannot say which columns it has cannot say
// which relations matter either.
const dedicatedRoutes = [
  createRoute({ getParentRoute: () => rootRoute, path: "/overview", component: OverviewPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/decisions", component: DecisionsPage }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/approvals",
    component: () => <Navigate to="/decisions" replace />,
  }),
  createRoute({ getParentRoute: () => rootRoute, path: "/inbox", component: InboxPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/runs", component: RunsPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/audit", component: AuditPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/usage", component: UsagePage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/people", component: PeoplePage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/access", component: AccessPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/api-access", component: ApiAccessPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/operations", component: OperationsPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/settings", component: SettingsPage }),
];

const catalogRoutes = [...CATALOG_RESOURCES].flatMap((resource) => [
  createRoute({
    getParentRoute: () => rootRoute,
    path: `/${resource}`,
    component: () => {
      const session = useSession();
      return (
        <CatalogPage resource={resource as DetailResource} permissions={session.permissions} />
      );
    },
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: `/${resource}/$resourceId`,
    component: () => {
      const session = useSession();
      return (
        <CatalogDetailPage
          resource={resource as DetailResource}
          permissions={session.permissions}
        />
      );
    },
  }),
]);

const routeTree = rootRoute.addChildren([
  indexRoute,
  chatRoute,
  newChatRoute,
  conversationRoute,
  ...dedicatedRoutes,
  ...catalogRoutes,
]);

export const router = createRouter({ routeTree, basepath: "/cockpit" });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
