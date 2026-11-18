import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { type ReactElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { retryQuery } from "@/api/client";
import { absolute } from "@/app/links";
import {
  INVITE_ROUTE,
  RECOVERY_ROUTE,
  STANDALONE_ROUTES,
  type StandaloneRoute,
  WELCOME_ROUTE,
} from "@/app/route-table";
import { router } from "@/app/router";
import { SessionGate } from "@/app/session";
import { I18nProvider } from "@/components/i18n-provider";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { IdentityRecoveryPage } from "@/pages/identity-recovery";
import { InvitePage } from "@/pages/invite";
import { WelcomePage } from "@/pages/welcome";
import "./index.css";
import "./branding.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      staleTime: 15_000,
      retry: retryQuery,
    },
    mutations: { retry: false },
  },
});

const STANDALONE_PAGES: Record<StandaloneRoute, () => ReactElement> = {
  [RECOVERY_ROUTE]: IdentityRecoveryPage,
  [WELCOME_ROUTE]: WelcomePage,
  [INVITE_ROUTE]: InvitePage,
};

const standalone = STANDALONE_ROUTES.find((route) => window.location.pathname === absolute(route));
const StandalonePage = standalone ? STANDALONE_PAGES[standalone] : null;

const root = document.getElementById("root");
if (!root) throw new Error("Cockpit root element is missing");

createRoot(root).render(
  <StrictMode>
    <I18nProvider>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          {StandalonePage ? (
            <>
              <StandalonePage />
              <Toaster richColors position="bottom-right" />
            </>
          ) : (
            <SessionGate>
              <RouterProvider router={router} />
            </SessionGate>
          )}
        </TooltipProvider>
      </QueryClientProvider>
    </I18nProvider>
  </StrictMode>,
);
