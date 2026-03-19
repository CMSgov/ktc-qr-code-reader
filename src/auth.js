import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcryptjs';

const COST_FACTOR = 10;

// HMAC secret — loaded from env or generated at startup (warn if generated)
let hmacSecret;

function getSecret() {
  if (hmacSecret) return hmacSecret;

  if (process.env.SESSION_SECRET) {
    hmacSecret = process.env.SESSION_SECRET;
  } else {
    hmacSecret = randomBytes(32).toString('hex');
    console.warn(
      'WARNING: No SESSION_SECRET env var set. Using random secret — tokens will not survive restarts.',
    );
  }
  return hmacSecret;
}

// ── Password Hashing ─────────────────────────────────────────────

export async function hashPassword(plaintext) {
  return bcrypt.hash(plaintext, COST_FACTOR);
}

export async function verifyPassword(plaintext, hash) {
  return bcrypt.compare(plaintext, hash);
}

// ── Token Creation & Verification ────────────────────────────────

/**
 * Create a signed session token.
 * @param {{ slug: string, role: 'admin'|'staff', orgId: string }} payload
 * @returns {string} base64url-encoded token
 */
export function createToken({ slug, role, orgId, timeoutMinutes }) {
  const expiresIn = timeoutMinutes ? timeoutMinutes * 60 : 12 * 60 * 60; // default 12h
  const payload = {
    slug,
    role,
    orgId,
    exp: Math.floor(Date.now() / 1000) + expiresIn,
  };

  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', getSecret()).update(payloadB64).digest('base64url');

  return `${payloadB64}.${sig}`;
}

/**
 * Verify and decode a signed session token.
 * @param {string} token
 * @returns {{ slug: string, role: string, orgId: string, exp: number } | null}
 */
export function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;

  const parts = token.split('.');
  if (parts.length !== 2) return null;

  const [payloadB64, sig] = parts;
  const expectedSig = createHmac('sha256', getSecret()).update(payloadB64).digest('base64url');

  // Timing-safe comparison to prevent timing side-channel attacks
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) return null;

  try {
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf-8'));

    // Check expiration
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;

    return payload;
  } catch {
    return null;
  }
}

// ── Express Middleware ────────────────────────────────────────────

/**
 * Express middleware factory. Checks Authorization: Bearer <token>.
 * Admin tokens can access staff routes. Staff tokens cannot access admin routes.
 *
 * @param {'admin'|'staff'} requiredRole
 */
export function authMiddleware(requiredRole) {
  return (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authentication required.' });
    }

    const token = authHeader.slice(7);
    const payload = verifyToken(token);

    if (!payload) {
      return res.status(401).json({ error: 'Invalid or expired token.' });
    }

    // Verify slug matches the route
    if (req.params.slug && payload.slug !== req.params.slug) {
      return res.status(403).json({ error: 'Access denied.' });
    }

    // Admin can access staff routes, but staff cannot access admin routes
    if (requiredRole === 'admin' && payload.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required.' });
    }

    req.org = payload;
    next();
  };
}
