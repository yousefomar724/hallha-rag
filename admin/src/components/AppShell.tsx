import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { authClient } from '@/lib/auth-client';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';

const navItems = [
  { to: '/', label: 'Dashboard' },
  { to: '/organizations', label: 'Organizations' },
  { to: '/users', label: 'Users' },
  { to: '/knowledge', label: 'Knowledge' },
];

export function AppShell() {
  const navigate = useNavigate();

  async function handleSignOut() {
    await authClient.signOut();
    navigate('/login');
  }

  return (
    <div className="flex min-h-screen">
      <aside className="w-56 flex-none border-r bg-muted/30 flex flex-col">
        <div className="px-4 py-5">
          <span className="text-sm font-semibold tracking-wide text-muted-foreground uppercase">
            Hallha Admin
          </span>
        </div>
        <Separator />
        <nav className="flex-1 px-2 py-4 space-y-1">
          {navItems.map(({ to, label }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) =>
                `block rounded-md px-3 py-2 text-sm transition-colors ${
                  isActive
                    ? 'bg-primary text-primary-foreground font-medium'
                    : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                }`
              }
            >
              {label}
            </NavLink>
          ))}
        </nav>
        <Separator />
        <div className="p-3">
          <Button variant="ghost" size="sm" className="w-full justify-start" onClick={() => void handleSignOut()}>
            Sign out
          </Button>
        </div>
      </aside>
      <main className="flex-1 overflow-auto p-6">
        <Outlet />
      </main>
    </div>
  );
}
