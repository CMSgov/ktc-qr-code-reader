import { describe, expect, it } from 'vitest';
import { isPrivateUrl, resolvesToPrivateAddress } from '../ssrf.js';

describe('proxy SSRF guard', () => {
  it('blocks plaintext HTTP to enforce encrypted-only policy', () => {
    expect(isPrivateUrl('http://example.com/manifest')).toBe(true);
  });

  it('blocks localhost and RFC1918 direct IPs', () => {
    expect(isPrivateUrl('https://localhost/manifest')).toBe(true);
    expect(isPrivateUrl('https://127.0.0.1/manifest')).toBe(true);
    expect(isPrivateUrl('https://192.168.1.10/manifest')).toBe(true);
  });

  it('allows public HTTPS URL pattern checks', () => {
    expect(isPrivateUrl('https://example.com/manifest')).toBe(false);
  });

  it('flags direct private IPs during DNS/address resolution checks', async () => {
    await expect(resolvesToPrivateAddress('https://10.0.0.1/manifest')).resolves.toBe(true);
    await expect(resolvesToPrivateAddress('https://8.8.8.8/manifest')).resolves.toBe(false);
  });
});
