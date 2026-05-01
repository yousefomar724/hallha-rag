const BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:8000';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error((body as { detail?: string }).detail ?? res.statusText);
  }
  return res.json() as Promise<T>;
}

export type Stats = {
  users: { total: number; last30d: number };
  organizations: { total: number; byPlan: Record<string, number>; onboardingCompleted: number };
  audits: { currentPeriodTotal: number };
  knowledgeChunks: number | null;
};

export type OrgItem = {
  _id: string;
  id?: string;
  name: string;
  plan: string;
  planStatus: string;
  usageAuditsThisPeriod: number;
  onboardingCompleted: boolean;
  createdAt: string;
};

export type OrgDetail = {
  org: OrgItem & Record<string, unknown>;
  memberCount: number;
  recentThreads: { threadId: string; title?: string; lastMessageAt?: string; createdAt: string }[];
};

export type UserItem = {
  _id: string;
  id?: string;
  name?: string;
  email: string;
  role?: string;
  banned?: boolean;
  createdAt?: string;
  emailVerified?: boolean;
};

export type PaginatedResponse<T> = {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
};

export const api = {
  stats: () => request<Stats>('/admin/stats'),

  organizations: (params?: { limit?: number; cursor?: string; plan?: string; search?: string }) => {
    const q = new URLSearchParams();
    if (params?.limit) q.set('limit', String(params.limit));
    if (params?.cursor) q.set('cursor', params.cursor);
    if (params?.plan) q.set('plan', params.plan);
    if (params?.search) q.set('search', params.search);
    return request<PaginatedResponse<OrgItem>>(`/admin/organizations?${q}`);
  },

  organization: (id: string) => request<OrgDetail>(`/admin/organizations/${id}`),

  users: (params?: { limit?: number; cursor?: string; search?: string; role?: string }) => {
    const q = new URLSearchParams();
    if (params?.limit) q.set('limit', String(params.limit));
    if (params?.cursor) q.set('cursor', params.cursor);
    if (params?.search) q.set('search', params.search);
    if (params?.role) q.set('role', params.role);
    return request<PaginatedResponse<UserItem>>(`/admin/users?${q}`);
  },

  setRole: (userId: string, role: string) =>
    request(`/admin/users/${userId}/role`, {
      method: 'POST',
      body: JSON.stringify({ role }),
    }),

  banUser: (userId: string, reason?: string) =>
    request(`/admin/users/${userId}/ban`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),

  unbanUser: (userId: string) =>
    request(`/admin/users/${userId}/unban`, { method: 'POST', body: '{}' }),

  uploadKnowledge: (file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return fetch(`${BASE}/upload-knowledge`, {
      method: 'POST',
      credentials: 'include',
      body: fd,
    }).then(async (res) => {
      if (!res.ok) {
        const body = await res.json().catch(() => ({ detail: res.statusText }));
        throw new Error((body as { detail?: string }).detail ?? res.statusText);
      }
      return res.json();
    });
  },
};
