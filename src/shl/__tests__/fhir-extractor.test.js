/**
 * Unit tests for fhir-extractor (validateFhirBundles; optionally extractHealthData with mocks). No PHI.
 */
import { describe, it, expect } from 'vitest';
import { validateFhirBundles, extractHealthData } from '../fhir-extractor.js';

describe('validateFhirBundles', () => {
  it('returns valid for empty array', () => {
    const result = validateFhirBundles([]);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('returns valid for null or undefined', () => {
    expect(validateFhirBundles(null)).toEqual({ valid: true, errors: [] });
    expect(validateFhirBundles(undefined)).toEqual({ valid: true, errors: [] });
  });

  it('returns valid for a well-formed Bundle', () => {
    const bundles = [
      {
        resourceType: 'Bundle',
        type: 'collection',
        entry: [
          { resource: { resourceType: 'Patient', id: '1' } },
          { resource: { resourceType: 'Observation', id: '2' } },
        ],
      },
    ];
    const result = validateFhirBundles(bundles);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('returns valid for a non-Bundle resource with resourceType', () => {
    const result = validateFhirBundles([{ resourceType: 'Patient', id: 'p1' }]);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('returns invalid when bundle is not an object', () => {
    const result = validateFhirBundles([null]);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Bundle 1: not a valid object');
  });

  it('returns invalid when resourceType is missing', () => {
    const result = validateFhirBundles([{ id: 'x' }]);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Bundle 1: missing resourceType');
  });

  it('returns invalid when Bundle entry resource is missing resourceType', () => {
    const bundles = [
      {
        resourceType: 'Bundle',
        entry: [{ resource: { id: '1' } }],
      },
    ];
    const result = validateFhirBundles(bundles);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('resource missing resourceType'))).toBe(true);
  });

  it('returns valid for Bundle with empty entry array', () => {
    const result = validateFhirBundles([{ resourceType: 'Bundle', entry: [] }]);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });
});

describe('extractHealthData', () => {
  it('returns empty results for manifest with no files', async () => {
    const result = await extractHealthData({ files: [] }, new Uint8Array(32));
    expect(result.fhirBundles).toEqual([]);
    expect(result.pdfs).toEqual([]);
    expect(result.raw).toEqual([]);
  });

  it('returns empty results for manifest with null files', async () => {
    const result = await extractHealthData({}, new Uint8Array(32));
    expect(result.fhirBundles).toEqual([]);
    expect(result.pdfs).toEqual([]);
    expect(result.raw).toEqual([]);
  });
});
