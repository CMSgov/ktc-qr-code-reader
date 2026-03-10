/**
 * POST extracted health data to a remote API endpoint.
 */
export async function postToApi(results, apiConfig, options = {}) {
  const { verbose = false } = options;
  const { url, headers = {}, fhirServerBase } = apiConfig;

  const posted = { fhir: 0, pdfs: 0, total: 0 };

  // Post FHIR bundles to FHIR server if configured
  if (fhirServerBase) {
    for (const bundle of results.fhirBundles) {
      const endpoint = fhirServerBase.replace(/\/$/, '');
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/fhir+json',
          ...headers,
        },
        body: JSON.stringify(bundle),
      });

      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        throw new Error(`FHIR server returned ${resp.status}: ${body.slice(0, 200)}`);
      }

      posted.fhir++;
      if (verbose) console.error(`Posted FHIR bundle to ${endpoint} (${resp.status})`);
    }
  }

  // Post full results to generic API endpoint
  if (url) {
    const payload = {
      timestamp: new Date().toISOString(),
      fhirBundles: results.fhirBundles,
      pdfs: results.pdfs.map((p) => ({
        filename: p.filename,
        data: p.data ? p.data.toString('base64') : null,
        url: p.url || null,
      })),
      raw: results.raw,
    };

    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`API endpoint returned ${resp.status}: ${body.slice(0, 200)}`);
    }

    posted.total++;
    if (verbose) console.error(`Posted full results to ${url} (${resp.status})`);
  }

  return posted;
}
