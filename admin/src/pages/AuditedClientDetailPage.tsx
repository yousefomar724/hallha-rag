import { useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

export function AuditedClientDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading, error } = useQuery({
    queryKey: ['audited-client', id],
    queryFn: () => api.auditedClient(id!),
    enabled: Boolean(id),
  });

  if (isLoading) {
    return <Skeleton className="h-40 w-full" />;
  }

  if (error) {
    return (
      <div className="text-sm text-destructive">
        {(error as Error).message ?? 'Failed to load client.'}
      </div>
    );
  }

  if (!data) return null;
  const { client, recentThreads } = data;

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold">{client.name}</h1>
        <p className="text-sm text-muted-foreground">
          Owned by{' '}
          <Link
            to={`/organizations/${client.organizationId}`}
            className="underline underline-offset-2"
          >
            {client.organizationName}
          </Link>
          {client.archivedAt ? (
            <Badge className="ml-2" variant="secondary">
              Archived
            </Badge>
          ) : null}
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Industry</span>
              <span>{client.industry ?? '—'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Documents</span>
              <span>{client.documentCount}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Created</span>
              <span>{new Date(client.createdAt).toLocaleString()}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Updated</span>
              <span>{new Date(client.updatedAt).toLocaleString()}</span>
            </div>
            {client.description ? (
              <div className="border-t pt-2 text-muted-foreground">{client.description}</div>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Recent chats</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {recentThreads.length === 0 ? (
              <p className="text-muted-foreground">No chats scoped to this client yet.</p>
            ) : (
              recentThreads.map((t) => (
                <div key={t.threadId} className="flex justify-between">
                  <span className="truncate">{t.title ?? '(no title)'}</span>
                  <span className="text-muted-foreground">
                    {t.lastMessageAt ? new Date(t.lastMessageAt).toLocaleDateString() : ''}
                  </span>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
