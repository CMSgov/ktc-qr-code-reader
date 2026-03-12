/**
 * Unit tests for sanitize (escapeHtml, isSafeBase64, isSafeUrl). No PHI.
 */
import { describe, it, expect } from 'vitest';
import { escapeHtml, isSafeBase64, isSafeUrl } from '../sanitize.js';

describe('escapeHtml', () => {
  it('returns empty string for null and undefined', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });

  it('returns empty string for empty string', () => {
    expect(escapeHtml('')).toBe('');
  });

  it('escapes ampersand', () => {
    expect(escapeHtml('a&b')).toBe('a&amp;b');
  });

  it('escapes angle brackets', () => {
    expect(escapeHtml('<script>')).toBe('&lt;script&gt;');
  });

  it('escapes double and single quotes', () => {
    expect(escapeHtml('"foo"')).toBe('&quot;foo&quot;');
    expect(escapeHtml("'bar'")).toBe('&#39;bar&#39;');
  });

  it('escapes all special chars together', () => {
    expect(escapeHtml('&<>"\'')).toBe('&amp;&lt;&gt;&quot;&#39;');
  });

  it('leaves safe text unchanged', () => {
    expect(escapeHtml('Hello World')).toBe('Hello World');
  });
});

describe('isSafeBase64', () => {
  it('returns true for valid base64 string', () => {
    expect(isSafeBase64('YWJj')).toBe(true);
    expect(isSafeBase64('ABC+/=')).toBe(true);
    expect(isSafeBase64('  a b c  ')).toBe(true);
  });

  it('returns false for invalid characters', () => {
    expect(isSafeBase64('a@b')).toBe(false);
    expect(isSafeBase64('a-b')).toBe(false);
    expect(isSafeBase64('a_b')).toBe(false);
  });

  it('returns false for non-string', () => {
    expect(isSafeBase64(null)).toBe(false);
    expect(isSafeBase64(123)).toBe(false);
  });
});

describe('isSafeUrl', () => {
  it('returns true for https URLs', () => {
    expect(isSafeUrl('https://example.com')).toBe(true);
    expect(isSafeUrl('https://example.com/path')).toBe(true);
  });

  it('returns false for http', () => {
    expect(isSafeUrl('http://example.com')).toBe(false);
  });

  it('returns false for javascript:', () => {
    expect(isSafeUrl('javascript:alert(1)')).toBe(false);
  });

  it('returns false for data:', () => {
    expect(isSafeUrl('data:text/html,<script>')).toBe(false);
  });

  it('returns false for invalid URL', () => {
    expect(isSafeUrl('not-a-url')).toBe(false);
    expect(isSafeUrl('')).toBe(false);
  });
});
