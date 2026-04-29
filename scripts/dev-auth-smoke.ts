/**
 * Quick dev check: sign-up (or sign-in), session, and optionally /chat-audit.
 *
 * Run with API already listening (e.g. `pnpm dev` in another terminal):
 *   pnpm run dev:auth-smoke
 *
 * Options:
 *   --sign-in    Use SMOKE_EMAIL / SMOKE_PASSWORD (skip sign-up)
 *   --skip-chat  Do not call /chat-audit (avoids Groq/Pinecone)
 */
import { env } from '../src/config/env.js';

const apiBase = env.BETTER_AUTH_URL.replace(/\/$/, '');
const trustedOrigin =
  env.AUTH_TRUSTED_ORIGINS.split(',')
    .map((s) => s.trim())
    .find(Boolean) ?? 'http://localhost:3000';

function cookieHeaderFromResponse(res: Response): string {
  const list =
    typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  if (list.length > 0) {
    return list.map((line) => line.split(';')[0]).join('; ');
  }
  const single = res.headers.get('set-cookie');
  if (!single) return '';
  return single
    .split(/\s*,\s*(?=[^;]+?=)/)
    .map((part) => part.split(';')[0])
    .filter(Boolean)
    .join('; ');
}

function argHas(flag: string): boolean {
  return process.argv.includes(flag);
}

async function main(): Promise<void> {
  const signInOnly = argHas('--sign-in');
  const skipChat = argHas('--skip-chat');

  const email = process.env.SMOKE_EMAIL ?? `smoke_${Date.now()}@example.test`;
  const password = process.env.SMOKE_PASSWORD ?? 'SmokeTest12345';
  const name = process.env.SMOKE_NAME ?? 'Smoke Test';

  const commonHeaders = {
    'Content-Type': 'application/json',
    Origin: trustedOrigin,
  };

  let cookieHeader: string;

  if (signInOnly) {
    const loginEmail = process.env.SMOKE_EMAIL;
    const loginPassword = process.env.SMOKE_PASSWORD;
    if (!loginEmail || !loginPassword) {
      console.error('With --sign-in, set SMOKE_EMAIL and SMOKE_PASSWORD in .env');
      process.exit(1);
    }
    const res = await fetch(`${apiBase}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: commonHeaders,
      body: JSON.stringify({ email: loginEmail, password: loginPassword }),
    });
    cookieHeader = cookieHeaderFromResponse(res);
    const body = await res.text();
    console.log('sign-in:', res.status, body.slice(0, 500));
    if (!res.ok) process.exit(1);
  } else {
    const res = await fetch(`${apiBase}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: commonHeaders,
      body: JSON.stringify({ email, password, name }),
    });
    cookieHeader = cookieHeaderFromResponse(res);
    const body = await res.text();
    console.log('sign-up:', res.status, body.slice(0, 500));
    if (!res.ok) {
      console.error('\nTip: user may already exist; use --sign-in with SMOKE_EMAIL / SMOKE_PASSWORD');
      process.exit(1);
    }
  }

  if (!cookieHeader) {
    console.error('No Set-Cookie from auth; check BETTER_AUTH_URL and trusted Origin.');
    process.exit(1);
  }
  console.log('\nCookie (for Postman):', cookieHeader.slice(0, 80) + '…\n');

  const sess = await fetch(`${apiBase}/api/auth/get-session`, {
    headers: { Cookie: cookieHeader, Origin: trustedOrigin },
  });
  console.log('get-session:', sess.status, await sess.text());

  if (skipChat) {
    console.log('\nSkipped /chat-audit (--skip-chat).');
    return;
  }

  const fd = new FormData();
  fd.append('thread_id', 'smoke-thread');
  fd.append('message', 'Smoke test — one-line audit please.');

  const audit = await fetch(`${apiBase}/chat-audit`, {
    method: 'POST',
    headers: { Cookie: cookieHeader, Origin: trustedOrigin },
    body: fd,
  });
  const auditText = await audit.text();
  console.log('/chat-audit:', audit.status, auditText.slice(0, 800));
  if (!audit.ok) process.exit(1);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
