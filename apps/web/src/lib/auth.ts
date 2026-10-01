import { createContext, useContext } from 'react';

/**
 * Simulated SSO session. The web deployment's /auth service issues an RS256 JWT; we keep it in
 * sessionStorage (per tab, cleared on close) and send it as a Bearer token on every API call.
 */
export interface SessionUser {
  sub: string;
  name: string;
  email: string;
  role: 'admin' | 'user';
}

export interface DirectoryUser {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'user';
  title: string;
}

const TOKEN_KEY = 'sb-token';

function decode(token: string): (SessionUser & { exp: number }) | null {
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return { sub: payload.sub, name: payload.name, email: payload.email, role: payload.roles?.includes('admin') ? 'admin' : 'user', exp: payload.exp };
  } catch {
    return null;
  }
}

export function getToken(): string | null {
  try {
    const token = sessionStorage.getItem(TOKEN_KEY);
    const claims = token ? decode(token) : null;
    if (!token || !claims || claims.exp * 1000 < Date.now()) return null;
    return token;
  } catch {
    return null;
  }
}

export function currentUser(): SessionUser | null {
  const token = getToken();
  const claims = token ? decode(token) : null;
  return claims && { sub: claims.sub, name: claims.name, email: claims.email, role: claims.role };
}

export async function directory(): Promise<DirectoryUser[]> {
  const res = await fetch('/auth/users');
  if (!res.ok) throw new Error('Identity provider unavailable.');
  return res.json();
}

export async function signIn(userId: string): Promise<SessionUser> {
  const res = await fetch('/auth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: userId }),
  });
  if (!res.ok) throw new Error('Sign-in failed.');
  const { access_token } = await res.json();
  sessionStorage.setItem(TOKEN_KEY, access_token);
  return currentUser()!;
}

export function signOut() {
  try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* storage unavailable */ }
}

export const AuthContext = createContext<{ user: SessionUser; signOut: () => void } | null>(null);

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside AuthContext');
  return ctx;
}
