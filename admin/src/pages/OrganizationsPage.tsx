import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, type OrgItem } from '@/lib/api';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

const PLAN_COLORS: Record<string, 'default' | 'secondary' | 'outline' | 'destructive'> = {
  free: 'secondary',
  starter: 'outline',
  business: 'default',
  enterprise: 'default',
};

export function OrganizationsPage() {
  const [search, setSearch] = useState('');
  const [plan, setPlan] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['organizations', debouncedSearch, plan],
    queryFn: () => api.organizations({ search: debouncedSearch || undefined, plan: plan || undefined, limit: 30 }),
  });

  function handleSearchChange(value: string) {
    setSearch(value);
    const t = setTimeout(() => setDebouncedSearch(value), 300);
    return () => clearTimeout(t);
  }

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Organizations</h1>
      <div className="flex gap-2">
        <Input
          placeholder="Search by name…"
          value={search}
          onChange={(e) => handleSearchChange(e.target.value)}
          className="max-w-xs"
        />
        <select
          value={plan}
          onChange={(e) => setPlan(e.target.value)}
          className="border rounded-md px-3 text-sm bg-background"
        >
          <option value="">All plans</option>
          {['free', 'starter', 'business', 'enterprise'].map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Plan</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Audits</TableHead>
              <TableHead>Onboarded</TableHead>
              <TableHead>Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading
              ? Array.from({ length: 8 }).map((_, i) => (
                  <TableRow key={i}>
                    {Array.from({ length: 6 }).map((_, j) => (
                      <TableCell key={j}><Skeleton className="h-4 w-full" /></TableCell>
                    ))}
                  </TableRow>
                ))
              : data?.items.map((org: OrgItem) => (
                  <TableRow key={org._id}>
                    <TableCell>
                      <Link
                        to={`/organizations/${org.id ?? org._id}`}
                        className="font-medium hover:underline"
                      >
                        {org.name}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Badge variant={PLAN_COLORS[org.plan] ?? 'secondary'}>{org.plan}</Badge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">{org.planStatus}</TableCell>
                    <TableCell className="text-right text-sm">{org.usageAuditsThisPeriod}</TableCell>
                    <TableCell>
                      <Badge variant={org.onboardingCompleted ? 'default' : 'secondary'}>
                        {org.onboardingCompleted ? 'Yes' : 'No'}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {org.createdAt ? new Date(org.createdAt).toLocaleDateString() : '—'}
                    </TableCell>
                  </TableRow>
                ))}
          </TableBody>
        </Table>
      </div>

      {data?.hasMore && (
        <div className="flex justify-center">
          <Button variant="outline" size="sm">Load more</Button>
        </div>
      )}
    </div>
  );
}
