import { useQuery } from '@tanstack/react-query';
import { api, type Stats } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';

const PLAN_COLORS: Record<string, string> = {
  free: 'secondary',
  starter: 'outline',
  business: 'default',
  enterprise: 'default',
};

function StatCard({ title, value, sub }: { title: string; value: string | number; sub?: string }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-2xl font-bold">{value}</p>
        {sub && <p className="text-xs text-muted-foreground mt-1">{sub}</p>}
      </CardContent>
    </Card>
  );
}

function StatCardSkeleton() {
  return (
    <Card>
      <CardHeader className="pb-2"><Skeleton className="h-4 w-24" /></CardHeader>
      <CardContent><Skeleton className="h-8 w-16 mt-1" /></CardContent>
    </Card>
  );
}

export function DashboardPage() {
  const { data, isLoading, error } = useQuery<Stats>({
    queryKey: ['stats'],
    queryFn: api.stats,
    refetchInterval: 60_000,
  });

  if (error) {
    return <p className="text-destructive text-sm">Failed to load stats: {(error as Error).message}</p>;
  }

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Dashboard</h1>

      <div className="grid gap-4 grid-cols-2 md:grid-cols-4">
        {isLoading || !data ? (
          Array.from({ length: 4 }).map((_, i) => <StatCardSkeleton key={i} />)
        ) : (
          <>
            <StatCard title="Total Users" value={data.users.total} sub={`+${data.users.last30d} last 30 days`} />
            <StatCard title="Organizations" value={data.organizations.total} sub={`${data.organizations.onboardingCompleted} onboarded`} />
            <StatCard title="Audits This Period" value={data.audits.currentPeriodTotal} />
            <StatCard
              title="Knowledge Chunks"
              value={data.knowledgeChunks ?? '—'}
              sub="vectors in Pinecone"
            />
          </>
        )}
      </div>

      {data && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Organizations by Plan</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-3">
              {Object.entries(data.organizations.byPlan).map(([plan, count]) => (
                <div key={plan} className="flex items-center gap-2">
                  <Badge variant={(PLAN_COLORS[plan] ?? 'secondary') as 'default' | 'secondary' | 'outline' | 'destructive'}>
                    {plan}
                  </Badge>
                  <span className="text-sm font-medium">{count}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
