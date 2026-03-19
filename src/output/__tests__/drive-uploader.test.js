/**
 * Unit tests for drive-uploader parseFolderId only. No PHI.
 */
import { describe, it, expect } from 'vitest';
import { parseFolderId } from '../drive-uploader.js';

describe('parseFolderId', () => {
  it('extracts folder ID from full URL', () => {
    expect(parseFolderId('https://drive.google.com/drive/folders/abc123xyz')).toBe('abc123xyz');
    expect(parseFolderId('https://drive.google.com/drive/folders/MyFolderId_123?usp=sharing')).toBe(
      'MyFolderId_123',
    );
  });

  it('returns raw ID when input is ID-only (no slashes)', () => {
    expect(parseFolderId('abc123')).toBe('abc123');
    expect(parseFolderId('folder-id_with-dash')).toBe('folder-id_with-dash');
  });

  it('returns null for invalid input', () => {
    expect(parseFolderId('')).toBe(null);
    expect(parseFolderId(null)).toBe(null);
    expect(parseFolderId(undefined)).toBe(null);
    expect(parseFolderId('https://example.com/not-drive')).toBe(null);
    expect(parseFolderId('folder/id/with/slashes')).toBe(null);
  });
});
