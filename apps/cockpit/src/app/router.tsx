import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import {
  AccessPage,
  ApiAccessPage,
  NotificationsPage,
  OperationsPage,
  PeoplePage,
  SettingsPage,
} from "@/pages/admin";
import { AuditPage } from "@/pages/audit";
import { CatalogPage } from "@/pages/catalog";
import { CatalogDetailPage, type DetailResource } from "@/pages/catalog-detail";
import { ChatPage } from "@/pages/chat";
import { DecisionsPage } from "@/pages/decisions";
import { InboxPage } from "@/pages/inbox";
import { OverviewPage } from "@/pages/overview";
import { RunsPage } from "@/pages/runs";
import { UsagePage } from "@/pages/usage";
import { ErrorScreen } from "./error-screen";
import { CATALOG_RESOURCES, CHAT_ROUTES, PAGE_ROUTES, type PageRoute } from "./route-table";
import { useSession } from "./session";
import { AppShell } from "./shell";

const rootRoute = createRootRoute({ component: AppShell });

// One component behind all three chat paths: a conversation is chosen from the
// path, not from a different page. The paths are read off the table by
// position rather than mapped over it — a mapped tuple loses its literal types,
// and with them every `<Link to="/chat">` in the product.
const [CHAT_PATH, NEW_CHAT_PATH, CONVERSATION_PATH] = CHAT_ROUTES;

const chatRoutes = [
  createRoute({ getParentRoute: () => rootRoute, path: CHAT_PATH, component: ChatPage }),
  createRoute({ getParentRoute: () => rootRoute, path: NEW_CHAT_PATH, component: ChatPage }),
  createRoute({ getParentRoute: () => rootRoute, path: CONVERSATION_PATH, component: ChatPage }),
];

// Every page is its own module (CUI-PAGE-2). There is no generic resource
// renderer any more: a list that cannot say which columns it has cannot say
// which relations matter either.
//
// The map is exhaustive over PAGE_ROUTES, so a page route that exists only
// here — invisible to the navigation and to the conformity sweep — cannot be
// added: it has to be in the table first, and then it is swept.
const PAGE_COMPONENTS: Record<PageRoute, () => React.ReactElement> = {
  "/": OverviewPage,
  "/decisions": DecisionsPage,
  "/inbox": InboxPage,
  "/runs": RunsPage,
  "/audit": AuditPage,
  "/usage": UsagePage,
  "/people": PeoplePage,
  "/access": AccessPage,
  "/api-access": ApiAccessPage,
  "/notifications": NotificationsPage,
  "/operations": OperationsPage,
  "/settings": SettingsPage,
};

const dedicatedRoutes = PAGE_ROUTES.map((path) =>
  createRoute({ getParentRoute: () => rootRoute, path, component: PAGE_COMPONENTS[path] }),
);

const catalogRoutes = CATALOG_RESOURCES.flatMap((resource) => [
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

const routeTree = rootRoute.addChildren([...chatRoutes, ...dedicatedRoutes, ...catalogRoutes]);

// One catch-all for every route: a render fault keeps the shell, the language
// and a way out, instead of the router's own English default.
export const router = createRouter({
  routeTree,
  basepath: "/cockpit",
  defaultErrorComponent: ErrorScreen,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
