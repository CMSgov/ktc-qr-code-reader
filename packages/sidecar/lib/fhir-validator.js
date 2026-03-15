/**
 * Validate that FHIR bundles contain well-formed FHIR resources.
 * Returns { valid: boolean, errors: string[] }
 */
export function validateFhirBundles(fhirBundles) {
  const errors = [];

  if (!fhirBundles || fhirBundles.length === 0) {
    return { valid: true, errors: [] };
  }

  for (let i = 0; i < fhirBundles.length; i++) {
    const bundle = fhirBundles[i];

    if (!bundle || typeof bundle !== 'object') {
      errors.push(`Bundle ${i + 1}: not a valid object`);
      continue;
    }

    if (!bundle.resourceType) {
      errors.push(`Bundle ${i + 1}: missing resourceType`);
      continue;
    }

    if (bundle.resourceType === 'Bundle' && bundle.entry && Array.isArray(bundle.entry)) {
      for (let j = 0; j < bundle.entry.length; j++) {
        const entry = bundle.entry[j];
        if (entry.resource && !entry.resource.resourceType) {
          errors.push(`Bundle ${i + 1}, entry ${j + 1}: resource missing resourceType`);
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}
