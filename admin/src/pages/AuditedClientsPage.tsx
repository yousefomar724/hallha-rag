import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, type AuditedClientItem } from '@/lib/api';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

export function AuditedClientsPage() {
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['audited-clients', debouncedSearch],
    queryFn: () =>
      api.auditedClients({ search: debouncedSearch || undefined, limit: 50 }),
  });

  function handleSearchChange(value: string) {
    setSearch(value);
    const t = setTimeout(() => setDebouncedSearch(value), 300);
    return () => clearTimeout(t);
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Audited clients</h1>
        <p className="text-sm text-muted-foreground">
          Read-only view of every audited client across all auditing firms.
        </p>
      </div>

      <Input
        placeholder="Search by client name…"
        value={search}
        onChange={(e) => handleSearchChange(e.target.value)}
        className="max-w-xs"
      />

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Client</TableHead>
              <TableHead>Firm</TableHead>
              <TableHead>Industry</TableHead>
              <TableHead className="text-right">Documents</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading
              ? Array.from({ length: 8 }).map((_, i) => (
                  <TableRow key={i}>
                    {Array.from({ length: 6 }).map((_, j) => (
                      <TableCell key={j}>
                        <Skeleton className="h-4 w-full" />
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              : data?.items.map((c: AuditedClientItem) => (
                  <TableRow key={c.id}>
                    <TableCell>
                      <Link
                        to={`/audited-clients/${c.id}`}
                        className="font-medium hover:underline"
                      >
                        {c.name}
                      </Link>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {c.organizationName}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {c.industry ?? '—'}
                    </TableCell>
                    <TableCell className="text-right text-sm">{c.documentCount}</TableCell>
                    <TableCell>
                      <Badge variant={c.archivedAt ? 'secondary' : 'default'}>
                        {c.archivedAt ? 'Archived' : 'Active'}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {new Date(c.createdAt).toLocaleDateString()}
                    </TableCell>
                  </TableRow>
                ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
