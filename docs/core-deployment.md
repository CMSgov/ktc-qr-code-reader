# Core deployment

Core is the **client-only** tier of Kill the Clipboard: all SHL parsing, decryption, and extraction run in the browser. No server handles PHI or stores credentials. Data is saved via **Web Share API** (mobile) or **browser download** (desktop).

## Build

```bash
npm run build:core
```

Output: `dist/core/index.html` and `dist/core/js/shl-client.js`, `dist/core/js/approved-apps.js`. The HTML sets `window.__CORE_ONLY__ = true` and uses relative paths so the app works when served from any base path.

## Deploy

1. Upload the contents of `dist/core/` to your static host or CDN.
2. Ensure `index.html` is served as the default document (e.g. `/` or `/index.html`).
3. Scripts are loaded as `js/shl-client.js` and `js/approved-apps.js`; CDN scripts (html5-qrcode, jose, pako) are loaded from unpkg/cdnjs.

No Node server is required. No environment variables or database.

## Requirements

- **HTTPS** in production (required for camera access).
- **Modern browser** with camera support, `fetch`, and (for Web Share on mobile) `navigator.share`.

## Behavior

- **Confirm before fetch:** After scanning a QR code, the app shows the SHL host and asks the user to click **Continue** or **Cancel** before fetching the manifest. This reduces risk from malicious or wrong-domain QR codes.
- **Direct fetch:** The client fetches the SHL manifest directly from the issuer when the server sends CORS headers. If CORS fails, the request fails unless an optional proxy is configured.
- **Optional proxy:** If you set `window.__CORE_PROXY_URL__` (e.g. to `https://your-server.com/api/shl-proxy`) before the app runs, the client will try direct fetch first and fall back to the proxy. The server must expose an unauthenticated proxy (e.g. run with `ENABLE_CORE_PROXY=1`; see README).
- **CMS app verification:** The two-step flow (app identity QR then health data QR) uses the embedded approved-app list in `approved-apps.js`; no server call. The list is derived from the [CMS Kill the Clipboard](https://www.cms.gov/health-tech-ecosystem/early-adopters/kill-the-clipboard) program (12 early adopters + 71+ pledgees) and is maintained by hand in `data/approved-apps.js`; see README and that file’s header for how to update.
- **Known-issuer host check (spoofed content):** The app treats a health data link as coming from a "known issuer" only when the manifest URL host is in a configurable list (`KNOWN_SHL_MANIFEST_HOSTS` in `approved-apps.js`). If the list is empty, every link is shown as unverified with a warning: "This domain is not in your list of known SHL issuers. Data could be spoofed." Populate the list from CMS or your list of legitimate SHL issuer hostnames (e.g. `['shl.example.org', 'health.apple.com']`) so staff see "known issuer" for trusted domains and a clear warning for others. This does not block unknown hosts; it makes spoofing risk explicit so staff only continue when they trust the source.

## Robustness and security (PHI-safe, reliable)

Core is designed so PHI stays in the browser and the app can be relied on under load and against common attacks:

- **PHI never leaves the device** except to the SHL server (encrypted) and, when used, to your optional proxy (encrypted only). Decryption key and decrypted data stay in browser memory; no server stores or logs PHI.
- **XSS and injection:** All user- and SHL-derived content (labels, filenames, error text) is escaped before display; PDF/data URLs are validated (base64 and https-only) before use in embeds or links.
- **DoS and abuse:** Client enforces a 5 MB decompression limit (JWE and SHC), a 30 s timeout on manifest and file fetches, and a cap of 100 files per manifest so a malicious QR cannot hang the tab or exhaust memory. Optional proxy uses the same SSRF rules and rate limit (30/min per IP) as the main app.
- **Confirm before fetch** ensures staff see the SHL host and choose Continue before any network request, reducing risk from wrong or spoofed QR codes.
- **Scalability:** Static Core scales with your CDN; there is no app server to saturate. If you use the optional proxy, it is single-instance and rate-limited.

For full security and compliance details, see **docs/security-and-compliance-spec.md**.

## Aligning with the architect spec

Core implements the capabilities in **docs/architect.md** §4.1 (Core, client-only): scan QR, validate SHL before any network call, fetch manifest (direct or via minimal CORS proxy), decrypt and parse in browser, display Card Details, save via Web Share or browser save dialog.
