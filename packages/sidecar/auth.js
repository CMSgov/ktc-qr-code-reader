import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcryptjs';

const COST_FACTOR = 10;
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

export async function hashPassword(plaintext) {
  return bcrypt.hash(plaintext, COST_FACTOR);
}

export async function verifyPassword(plaintext, hash) {
  return bcrypt.compare(plaintext, hash);
}

export function createToken({ slug, role, orgId, timeoutMinutes }) {
  const expiresIn = timeoutMinutes ? timeoutMinutes * 60 : 12 * 60 * 60;
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

export function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, sig] = parts;
  const expectedSig = createHmac('sha256', getSecret()).update(payloadB64).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) return null;
  try {
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf-8'));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

export function authMiddleware(requiredRole) {
  return (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authentication required.' });
    }
    const token = authHeader.slice(7);
    const payload = verifyToken(token);
    if (!payload) return res.status(401).json({ error: 'Invalid or expired token.' });
    if (req.params.slug && payload.slug !== req.params.slug) {
      return res.status(403).json({ error: 'Access denied.' });
    }
    if (requiredRole === 'admin' && payload.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required.' });
    }
    req.org = payload;
    next();
  };
}
