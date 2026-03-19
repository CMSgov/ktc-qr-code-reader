/**
 * SSRF protection: block requests to private/internal networks.
 * Used by the SHL CORS proxy to prevent abuse.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export function isPrivateUrl(urlString) {
  try {
    const url = new URL(urlString);
    const hostname = url.hostname.toLowerCase();

    // Encrypted-traffic-only policy for SHL proxy.
    if (url.protocol !== 'https:') return true;

    // Block private IPs and localhost
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return true;
    if (hostname === '0.0.0.0') return true;
    if (hostname.endsWith('.local')) return true;
    if (hostname.endsWith('.internal')) return true;

    // Block cloud metadata endpoints (AWS, GCP, Azure)
    if (hostname === '169.254.169.254') return true;
    if (hostname === 'metadata.google.internal') return true;

    // Block IPv6-mapped IPv4 addresses (e.g., ::ffff:127.0.0.1)
    const ipv6MappedMatch = hostname.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (ipv6MappedMatch) {
      return isPrivateIpv4(ipv6MappedMatch[1]);
    }

    // Block IPv6 private ranges
    if (hostname.startsWith('fe80:')) return true; // Link-local
    if (hostname.startsWith('fc') || hostname.startsWith('fd')) return true; // Unique local
    if (hostname === '::') return true; // Unspecified

    // Block direct private IPs.
    if (isPrivateIp(hostname)) return true;

    return false;
  } catch {
    return true; // Malformed URLs are blocked
  }
}

/**
 * Resolve hostnames and block if any resolved address is private/internal.
 * This protects against domains that point to private IP space.
 */
export async function resolvesToPrivateAddress(urlString) {
  try {
    const url = new URL(urlString);
    const hostname = url.hostname;

    if (isIP(hostname)) {
      return isPrivateIp(hostname);
    }

    const resolved = await lookup(hostname, { all: true, verbatim: true });
    if (!resolved || resolved.length === 0) return true;

    return resolved.some((entry) => isPrivateIp(entry.address));
  } catch {
    // Fail closed on DNS/parsing errors.
    return true;
  }
}

function isPrivateIp(value) {
  if (isPrivateIpv4(value)) return true;
  if (isPrivateIpv6(value)) return true;
  return false;
}

function isPrivateIpv4(address) {
  const parts = address.split('.');
  if (parts.length !== 4 || !parts.every((p) => /^\d+$/.test(p))) return false;
  const [a, b] = parts.map(Number);
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 (link-local)
  if (a === 127) return true; // 127.0.0.0/8 (loopback)
  return false;
}

function isPrivateIpv6(address) {
  const normalized = address.toLowerCase();
  if (normalized === '::1' || normalized === '::') return true;
  if (normalized.startsWith('fe80:')) return true; // Link-local
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true; // Unique local
  if (normalized.startsWith('::ffff:')) {
    const mapped = normalized.slice('::ffff:'.length);
    return isPrivateIpv4(mapped);
  }
  return false;
}
