import { useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';

export function OrganizationDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading, error } = useQuery({
    queryKey: ['organization', id],
    queryFn: () => api.organization(id!),
    enabled: !!id,
  });

  if (error) {
    return <p className="text-destructive text-sm">Error: {(error as Error).message}</p>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <Link to="/organizations" className="text-sm text-muted-foreground hover:underline">
          Organizations
        </Link>
        <span className="text-muted-foreground">/</span>
        {isLoading ? (
          <Skeleton className="h-4 w-32" />
        ) : (
          <span className="text-sm font-medium">{data?.org.name as string}</span>
        )}
      </div>

      {isLoading ? (
        <div className="grid gap-4 md:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Card key={i}>
              <CardContent className="pt-6"><Skeleton className="h-16 w-full" /></CardContent>
            </Card>
          ))}
        </div>
      ) : data ? (
        <>
          <div className="grid gap-4 md:grid-cols-3">
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">Plan</CardTitle></CardHeader>
              <CardContent>
                <Badge className="text-sm">{data.org.plan as string}</Badge>
                <p className="text-xs text-muted-foreground mt-1">{data.org.planStatus as string}</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">Audits this period</CardTitle></CardHeader>
              <CardContent><p className="text-2xl font-bold">{data.org.usageAuditsThisPeriod as number}</p></CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">Members</CardTitle></CardHeader>
              <CardContent><p className="text-2xl font-bold">{data.memberCount}</p></CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader><CardTitle className="text-base">Recent Chats</CardTitle></CardHeader>
            <CardContent>
              {data.recentThreads.length === 0 ? (
                <p className="text-sm text-muted-foreground">No chat threads yet.</p>
              ) : (
                <ul className="space-y-2">
                  {data.recentThreads.map((t) => (
                    <li key={t.threadId} className="flex justify-between text-sm">
                      <span className="text-muted-foreground truncate max-w-sm">{t.title ?? t.threadId}</span>
                      <span className="text-muted-foreground text-xs">
                        {t.lastMessageAt ? new Date(t.lastMessageAt).toLocaleDateString() : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-base">Details</CardTitle></CardHeader>
            <CardContent className="grid gap-2 text-sm">
              {(['legalName', 'country', 'industry', 'registrationNumber'] as const).map((field) =>
                data.org[field] ? (
                  <div key={field} className="flex gap-2">
                    <span className="text-muted-foreground capitalize w-40">{field}</span>
                    <span>{String(data.org[field])}</span>
                  </div>
                ) : null,
              )}
            </CardContent>
          </Card>
        </>
      ) : null}
    </div>
  );
}
