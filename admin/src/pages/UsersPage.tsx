import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type UserItem } from '@/lib/api';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { toast } from 'sonner';

type RoleDialogState = { open: boolean; userId: string; currentRole: string };

export function UsersPage() {
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [roleDialog, setRoleDialog] = useState<RoleDialogState>({ open: false, userId: '', currentRole: '' });
  const [newRole, setNewRole] = useState('user');

  const { data, isLoading } = useQuery({
    queryKey: ['users', debouncedSearch],
    queryFn: () => api.users({ search: debouncedSearch || undefined, limit: 30 }),
  });

  const setRoleMut = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: string }) => api.setRole(userId, role),
    onSuccess: () => {
      toast.success('Role updated.');
      void qc.invalidateQueries({ queryKey: ['users'] });
      setRoleDialog({ open: false, userId: '', currentRole: '' });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const banMut = useMutation({
    mutationFn: ({ userId }: { userId: string }) => api.banUser(userId),
    onSuccess: () => { toast.success('User banned.'); void qc.invalidateQueries({ queryKey: ['users'] }); },
    onError: (err: Error) => toast.error(err.message),
  });

  const unbanMut = useMutation({
    mutationFn: ({ userId }: { userId: string }) => api.unbanUser(userId),
    onSuccess: () => { toast.success('User unbanned.'); void qc.invalidateQueries({ queryKey: ['users'] }); },
    onError: (err: Error) => toast.error(err.message),
  });

  function handleSearchChange(value: string) {
    setSearch(value);
    const t = setTimeout(() => setDebouncedSearch(value), 300);
    return () => clearTimeout(t);
  }

  function openRoleDialog(user: UserItem) {
    setNewRole(user.role ?? 'user');
    setRoleDialog({ open: true, userId: user.id ?? user._id, currentRole: user.role ?? 'user' });
  }

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Users</h1>
      <Input
        placeholder="Search by name or email…"
        value={search}
        onChange={(e) => handleSearchChange(e.target.value)}
        className="max-w-xs"
      />

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Verified</TableHead>
              <TableHead>Joined</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading
              ? Array.from({ length: 8 }).map((_, i) => (
                  <TableRow key={i}>
                    {Array.from({ length: 7 }).map((_, j) => (
                      <TableCell key={j}><Skeleton className="h-4 w-full" /></TableCell>
                    ))}
                  </TableRow>
                ))
              : data?.items.map((user: UserItem) => (
                  <TableRow key={user._id}>
                    <TableCell className="font-medium">{user.name ?? '—'}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{user.email}</TableCell>
                    <TableCell>
                      <Badge variant={user.role === 'superadmin' || user.role === 'admin' ? 'default' : 'secondary'}>
                        {user.role ?? 'user'}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {user.banned ? <Badge variant="destructive">Banned</Badge> : <Badge variant="outline">Active</Badge>}
                    </TableCell>
                    <TableCell className="text-sm">
                      {user.emailVerified ? '✓' : '—'}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {user.createdAt ? new Date(user.createdAt).toLocaleDateString() : '—'}
                    </TableCell>
                    <TableCell>
                      <DropdownMenu>
                        <DropdownMenuTrigger className="inline-flex items-center justify-center rounded-md h-8 w-8 text-sm font-medium hover:bg-accent hover:text-accent-foreground focus-visible:outline-none">
                          ⋯
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => openRoleDialog(user)}>
                            Set role
                          </DropdownMenuItem>
                          {user.banned ? (
                            <DropdownMenuItem onClick={() => unbanMut.mutate({ userId: user.id ?? user._id })}>
                              Unban
                            </DropdownMenuItem>
                          ) : (
                            <DropdownMenuItem
                              className="text-destructive"
                              onClick={() => banMut.mutate({ userId: user.id ?? user._id })}
                            >
                              Ban user
                            </DropdownMenuItem>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))}
          </TableBody>
        </Table>
      </div>

      <Dialog open={roleDialog.open} onOpenChange={(o) => setRoleDialog((s) => ({ ...s, open: o }))}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Change role</DialogTitle>
          </DialogHeader>
          <select
            value={newRole}
            onChange={(e) => setNewRole(e.target.value)}
            className="border rounded-md px-3 py-2 text-sm bg-background w-full"
          >
            {['user', 'admin', 'superadmin'].map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRoleDialog((s) => ({ ...s, open: false }))}>
              Cancel
            </Button>
            <Button
              onClick={() => setRoleMut.mutate({ userId: roleDialog.userId, role: newRole })}
              disabled={setRoleMut.isPending}
            >
              {setRoleMut.isPending ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
