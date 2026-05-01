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

export type KnowledgeFileItem = {
  key: string;
  name: string;
  size: number;
  lastModified: string;
  url: string;
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

  listKnowledgeFiles: (params?: { cursor?: string }) => {
    const q = new URLSearchParams();
    if (params?.cursor) q.set('cursor', params.cursor);
    const suffix = q.toString() ? `?${q}` : '';
    return request<PaginatedResponse<KnowledgeFileItem>>(`/admin/knowledge-files${suffix}`);
  },

  uploadKnowledge: (file: File, onProgress?: (loaded: number, total: number) => void) =>
    new Promise<unknown>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${BASE}/upload-knowledge`);
      xhr.withCredentials = true;
      xhr.upload.onprogress = (ev) => {
        if (ev.lengthComputable && ev.total > 0 && onProgress) {
          onProgress(ev.loaded, ev.total);
        }
      };
      xhr.onload = () => {
        const body: unknown = (() => {
          try {
            return xhr.responseText ? JSON.parse(xhr.responseText) : {};
          } catch {
            return {};
          }
        })();
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(body);
        } else {
          const detail =
            typeof body === 'object' && body !== null && 'detail' in body
              ? String((body as { detail: unknown }).detail)
              : xhr.statusText;
          reject(new Error(detail || xhr.statusText));
        }
      };
      xhr.onerror = () => reject(new Error('Network error'));
      const fd = new FormData();
      fd.append('file', file);
      xhr.send(fd);
    }),
};
