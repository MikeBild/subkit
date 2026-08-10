import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import { ChevronsUpDown, LogOut, Moon, Sun, Workflow } from "lucide-react";
import { useState } from "react";
import { logout } from "@/api/client";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
} from "@/components/ui/breadcrumb";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/sonner";
import { navigationItem, visibleNavigation } from "./navigation";
import { useSession } from "./session";

function initials(value: string): string {
  return (
    value
      .split(/[@\s._-]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("") || "SK"
  );
}

function setTheme(theme: "light" | "dark" | "system") {
  if (theme === "system") localStorage.removeItem("sk-cockpit-theme");
  else localStorage.setItem("sk-cockpit-theme", theme);
  const dark =
    theme === "dark" || (theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
}

export function AppShell() {
  const session = useSession();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const current = navigationItem(pathname.replace(/^\/cockpit/, ""));
  const groups = visibleNavigation(session.permissions);
  const [signingOut, setSigningOut] = useState(false);
  const identity = session.principal.email || session.principal.role_name || "Subkit user";

  return (
    <SidebarProvider>
      <Sidebar collapsible="icon" data-cockpit-ui="product-sidebar">
        <SidebarHeader>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton asChild size="lg">
                <Link to="/chat">
                  <span className="grid size-8 place-items-center rounded-lg bg-primary text-primary-foreground">
                    <Workflow className="size-4" />
                  </span>
                  <span className="grid flex-1 text-left text-sm leading-tight">
                    <span className="truncate font-semibold">Subkit</span>
                    <span className="truncate text-xs">{session.tenant.display_name}</span>
                  </span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>
        <SidebarContent>
          {groups.map((group) => (
            <SidebarGroup key={group.label}>
              <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {group.items.map((item) => (
                    <SidebarMenuItem key={item.path}>
                      <SidebarMenuButton
                        asChild
                        tooltip={item.label}
                        isActive={pathname.endsWith(item.path)}
                      >
                        <Link to={item.path}>
                          <item.icon />
                          <span>{item.label}</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          ))}
        </SidebarContent>
        <SidebarFooter>
          <SidebarMenu>
            <SidebarMenuItem>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <SidebarMenuButton size="lg">
                    <Avatar className="size-8 rounded-lg">
                      <AvatarFallback className="rounded-lg">{initials(identity)}</AvatarFallback>
                    </Avatar>
                    <span className="grid flex-1 text-left text-sm leading-tight">
                      <span className="truncate font-medium">{identity}</span>
                      <span className="truncate text-xs">
                        {session.principal.role_name || "Member"}
                      </span>
                    </span>
                    <ChevronsUpDown className="ml-auto size-4" />
                  </SidebarMenuButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent side="right" align="end" className="w-56">
                  <DropdownMenuLabel>
                    <span className="block truncate">{session.tenant.display_name}</span>
                    <span className="block truncate text-xs font-normal text-muted-foreground">
                      Engine {session.version}
                    </span>
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => setTheme("light")}>
                    <Sun /> Light
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setTheme("dark")}>
                    <Moon /> Dark
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setTheme("system")}>
                    <Sun /> System
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    disabled={signingOut}
                    onClick={async () => {
                      setSigningOut(true);
                      try {
                        await logout();
                        window.location.assign("/cockpit/");
                      } finally {
                        setSigningOut(false);
                      }
                    }}
                  >
                    <LogOut /> Sign out
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>
      <SidebarInset className="h-svh min-h-0 overflow-hidden">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
          <SidebarTrigger className="-ml-1" />
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbPage>{current?.label || "Cockpit"}</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        </header>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <Outlet />
        </div>
      </SidebarInset>
      <Toaster richColors position="bottom-right" />
    </SidebarProvider>
  );
}
