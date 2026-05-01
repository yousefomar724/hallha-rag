export type AuthedUser = {
  id: string;
  email: string;
  name?: string | null;
  role?: string | null;
};

export type AuthedSession = {
  id: string;
  token: string;
  activeOrganizationId?: string | null;
};

declare global {
  namespace Express {
    interface Request {
      user?: AuthedUser;
      /** Better Auth session (distinct from express-session). */
      authSession?: AuthedSession;
      activeOrgId?: string;
    }
  }
}

export {};

