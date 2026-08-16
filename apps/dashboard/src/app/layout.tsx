"use client";

import { useState, Suspense } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu, X } from "lucide-react";
import { cn } from "@/lib/utils";
import RootLayout from "@/root-layout";
import { ThemeToggle } from "@/components/theme-toggle";
import { ErrorBoundary } from "@/components/error-boundary";

const navigation = [
  { name: "Dashboard", href: "/", icon: "📊" },
  { name: "Sources", href: "/sources", icon: "📡" },
  { name: "Source Types", href: "/source-types", icon: "📋" },
  { name: "Categories", href: "/categories", icon: "🏷️" },
  { name: "Schedules", href: "/schedules", icon: "📅" },
  { name: "Telegram", href: "/telegram", icon: "📱" },
  { name: "WhatsApp", href: "/whatsapp", icon: "💬" },
  { name: "Cookies", href: "/cookies", icon: "🔐" },
  { name: "Settings", href: "/settings", icon: "⚙️" },
];

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const pathname = usePathname();

  return (
    <RootLayout>
      <div className="flex h-screen bg-background">
        {sidebarOpen && (
          <div
            className="fixed inset-0 z-40 bg-black bg-opacity-50 lg:hidden"
            onClick={() => setSidebarOpen(false)}
          />
        )}

        <aside
          className={cn(
            "fixed inset-y-0 left-0 z-50 w-64 transform bg-card border-r transition-transform duration-300 ease-in-out lg:translate-x-0 lg:static lg:w-64",
            sidebarOpen ? "translate-x-0" : "-translate-x-full"
          )}
        >
          <div className="flex h-full flex-col">
            <div className="flex h-14 items-center gap-2 border-b px-4">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                <span className="text-sm font-bold">B</span>
              </div>
              <div className="flex flex-col">
                <span className="text-sm font-semibold">Brief Agent</span>
                <span className="text-xs text-muted-foreground">Dashboard v1.0.0</span>
              </div>
            </div>

            <nav className="flex-1 overflow-y-auto px-2 py-4">
              <ul className="space-y-1">
                {navigation.map((item) => (
                  <li key={item.name}>
                    <Link
                      href={item.href}
                      className={cn(
                        "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                        item.href === "/"
                          ? pathname === "/" && "bg-accent/10 text-accent font-medium"
                          : pathname.startsWith(item.href) && "bg-accent/10 text-accent font-medium",
                        !(item.href === "/" ? pathname === "/" : pathname.startsWith(item.href)) &&
                          "hover:bg-accent hover:text-accent-foreground"
                      )}
                    >
                      <span className="text-lg">{item.icon}</span>
                      <span>{item.name}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>

            <div className="border-t p-4">
              <div className="flex items-center gap-3">
                <div className="h-8 w-8 rounded-full bg-muted" />
                <div className="flex-1">
                  <div className="text-sm font-medium">System Admin</div>
                  <div className="text-xs text-muted-foreground">admin@briefing.ai</div>
                </div>
                <ThemeToggle />
              </div>
            </div>
          </div>
        </aside>

        <main className="flex flex-1 flex-col overflow-hidden lg:ml-0">
          <header className="flex h-14 items-center gap-4 border-b bg-card px-4 lg:hidden">
            <button
              onClick={() => setSidebarOpen(true)}
              className="inline-flex h-10 w-10 items-center justify-center rounded-md text-sm font-medium ring-offset-background transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50"
            >
              <Menu className="h-4 w-4" />
              <span className="sr-only">Open sidebar</span>
            </button>
            <div className="flex-1">
              <h1 className="text-lg font-semibold">Brief Agent Dashboard</h1>
            </div>
          </header>

          <div className="flex-1 overflow-y-auto p-4 lg:p-6">
            <Suspense fallback={<div className="animate-pulse h-96 rounded-lg bg-surface-2" />}>
              <ErrorBoundary>
                {children}
              </ErrorBoundary>
            </Suspense>
          </div>
        </main>
      </div>
    </RootLayout>
  );
}

