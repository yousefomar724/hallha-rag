import { Navigate } from 'react-router-dom';
import { authClient } from '@/lib/auth-client';

const ADMIN_ROLES = new Set(['admin', 'superadmin']);

export function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { data: session, isPending } = authClient.useSession();

  if (isPending) {
    return <div className="flex min-h-screen items-center justify-center text-muted-foreground text-sm">Loading…</div>;
  }

  if (!session?.user) {
    return <Navigate to="/login" replace />;
  }

  const role = (session.user as { role?: string }).role;
  if (!role || !ADMIN_ROLES.has(role)) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3">
        <p className="text-lg font-semibold">Access denied</p>
        <p className="text-muted-foreground text-sm">Your account does not have admin access.</p>
      </div>
    );
  }

  return <>{children}</>;
}
