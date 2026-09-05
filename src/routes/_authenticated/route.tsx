import { createFileRoute, Link, Outlet, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { isAdmin } from "@/lib/dashboard.functions";

export const Route = createFileRoute("/_authenticated")({
  component: AuthenticatedLayout,
});

const nav = [
  { to: "/dashboard", label: "Overview" },
  { to: "/jobs", label: "Jobs" },
  { to: "/users", label: "Users" },
  { to: "/settings", label: "Settings" },
];

function AuthenticatedLayout() {
  const navigate = useNavigate();
  const [ready, setReady] = useState(false);
  const [admin, setAdmin] = useState(false);

  useEffect(() => {
    let mounted = true;
    supabase.auth.getSession().then(async ({ data }) => {
      if (!mounted) return;
      if (!data.session) {
        navigate({ to: "/auth" });
        return;
      }
      try {
        const { admin: isAdminUser } = await isAdmin();
        if (!isAdminUser) {
          await supabase.auth.signOut();
          navigate({ to: "/auth" });
          return;
        }
        setAdmin(true);
      } catch {
        await supabase.auth.signOut();
        navigate({ to: "/auth" });
      } finally {
        setReady(true);
      }
    });

    const { data: listener } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_OUT" || !session) {
        navigate({ to: "/auth" });
      }
    });

    return () => {
      mounted = false;
      listener.subscription.unsubscribe();
    };
  }, [navigate]);

  const signOut = async () => {
    await supabase.auth.signOut();
    navigate({ to: "/auth" });
  };

  if (!ready || !admin) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <p className="text-muted-foreground">Loading dashboard…</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <aside className="fixed left-0 top-0 z-40 hidden h-screen w-60 border-r border-border bg-card p-5 lg:block">
        <Link to="/" className="block font-display text-xl font-bold tracking-tight">
          Marco Uploader
        </Link>
        <nav className="mt-8 space-y-1">
          {nav.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              activeProps={{ className: "bg-primary/10 text-primary" }}
              inactiveProps={{ className: "text-muted-foreground hover:bg-accent hover:text-accent-foreground" }}
              className="block rounded-md px-3 py-2 text-sm font-medium transition-colors"
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="absolute bottom-5 left-5 right-5">
          <Button variant="outline" className="w-full" onClick={signOut}>
            Sign out
          </Button>
        </div>
      </aside>

      <header className="sticky top-0 z-30 flex h-16 items-center justify-between border-b border-border bg-background/80 px-5 backdrop-blur lg:ml-60">
        <span className="font-display text-lg font-bold lg:hidden">Marco Uploader</span>
        <nav className="flex gap-2 overflow-x-auto lg:hidden">
          {nav.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              activeProps={{ className: "text-primary" }}
              inactiveProps={{ className: "text-muted-foreground" }}
              className="whitespace-nowrap text-sm font-medium"
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <Button variant="ghost" size="sm" onClick={signOut} className="hidden lg:inline-flex">
          Sign out
        </Button>
      </header>

      <main className="px-5 pb-12 pt-6 lg:ml-60">
        <Outlet />
      </main>
    </div>
  );
}
