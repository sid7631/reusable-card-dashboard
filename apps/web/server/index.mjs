/**
 * Web deployment server.
 *
 * - Simulated SSO identity provider: issues RS256 JWTs for demo users and publishes the JWKS the
 *   API verifies against. Replace with a real IdP (Okta, Azure AD, ...) by pointing the API's
 *   JWKS_URL / issuer / audience at it — nothing else changes.
 * - In production (`dist/` exists) it also serves the SPA and proxies /api to the FastAPI service.
 */
import express from 'express';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SignJWT, exportJWK, generateKeyPair, importJWK, calculateJwkThumbprint } from 'jose';
import { createProxyMiddleware } from 'http-proxy-middleware';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3001);
const API_URL = process.env.API_URL || 'http://localhost:8010';
const ISSUER = 'spendboard-auth';
const AUDIENCE = 'spendboard-api';
const TOKEN_TTL_S = 60 * 60;

// The IdP's user directory (stand-in for SSO accounts)
const USERS = [
  { id: 'u-avery', name: 'Avery Admin', email: 'avery@spendboard.local', roles: ['admin'], title: 'Platform admin' },
  { id: 'u-morgan', name: 'Morgan Admin', email: 'morgan@spendboard.local', roles: ['admin'], title: 'Data governance lead' },
  { id: 'u-riley', name: 'Riley Analyst', email: 'riley@spendboard.local', roles: ['user'], title: 'Spend analyst' },
  { id: 'u-jordan', name: 'Jordan Analyst', email: 'jordan@spendboard.local', roles: ['user'], title: 'Finance analyst' },
];

// Signing key persists across restarts so issued tokens stay valid
async function loadSigningKey() {
  const dir = path.join(__dirname, '.keys');
  const file = path.join(dir, 'signing-key.json');
  if (existsSync(file)) {
    const jwk = JSON.parse(readFileSync(file, 'utf8'));
    return { privateKey: await importJWK(jwk, 'RS256'), publicJwk: { kty: jwk.kty, n: jwk.n, e: jwk.e, kid: jwk.kid } };
  }
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  const kid = await calculateJwkThumbprint(publicJwk);
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify({ ...(await exportJWK(privateKey)), kid }), { mode: 0o600 });
  return { privateKey, publicJwk: { ...publicJwk, kid } };
}

const { privateKey, publicJwk } = await loadSigningKey();
const app = express();

app.get('/auth/.well-known/jwks.json', (_req, res) => {
  res.json({ keys: [{ ...publicJwk, alg: 'RS256', use: 'sig' }] });
});

app.get('/auth/users', (_req, res) => {
  res.json(USERS.map(({ id, name, email, roles, title }) => ({ id, name, email, role: roles[0], title })));
});

app.post('/auth/token', express.json(), async (req, res) => {
  const user = USERS.find((u) => u.id === req.body?.user_id);
  if (!user) return res.status(400).json({ error: 'Unknown user.' });
  const token = await new SignJWT({ name: user.name, email: user.email, roles: user.roles })
    .setProtectedHeader({ alg: 'RS256', kid: publicJwk.kid })
    .setSubject(user.id)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${TOKEN_TTL_S}s`)
    .sign(privateKey);
  res.json({ access_token: token, token_type: 'Bearer', expires_in: TOKEN_TTL_S });
});

const dist = path.join(__dirname, '..', 'dist');
if (existsSync(dist)) {
  // Mounted at the root so the /api prefix is kept when forwarding
  app.use(createProxyMiddleware({ target: API_URL, changeOrigin: true, pathFilter: '/api' }));
  app.use(express.static(dist));
  app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

app.listen(PORT, () => console.log(`SpendBoard web/auth listening on http://localhost:${PORT}`));
