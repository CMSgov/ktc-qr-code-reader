/**
 * Unit tests for base64url (decode, decodeToString, encode). No PHI.
 */
import { describe, it, expect } from 'vitest';
import { decode, decodeToString, encode } from '../base64url.js';

describe('base64url', () => {
  it('decode returns Uint8Array from base64url string', () => {
    const bytes = decode('YWJj');
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBe(3);
    expect(bytes[0]).toBe(97);
    expect(bytes[1]).toBe(98);
    expect(bytes[2]).toBe(99);
  });

  it('decodeToString returns UTF-8 string', () => {
    expect(decodeToString('YWJj')).toBe('abc');
    expect(decodeToString('SGVsbG8gV29ybGQ')).toBe('Hello World');
  });

  it('encode converts bytes to base64url', () => {
    const bytes = new Uint8Array([97, 98, 99]);
    expect(encode(bytes)).toBe('YWJj');
  });

  it('round-trip: encode then decode', () => {
    const original = new Uint8Array([1, 2, 3, 255, 0]);
    const b64 = encode(original);
    const decoded = decode(b64);
    expect(decoded).toEqual(original);
  });

  it('round-trip: string to decodeToString then encode', () => {
    const text = 'Hello';
    const bytes = new TextEncoder().encode(text);
    const b64 = encode(bytes);
    expect(decodeToString(b64)).toBe(text);
  });

  it('handles empty and padding', () => {
    expect(decode('')).toEqual(new Uint8Array(0));
    const oneByte = encode(new Uint8Array([1]));
    expect(decode(oneByte).length).toBe(1);
  });
});
