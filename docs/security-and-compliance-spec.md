# Kill the Clipboard — Security & Compliance Specification

**Version:** 1.0
**Date:** March 4, 2026
**Classification:** For distribution to CISO and compliance review teams
**Contact:** agleason@russellstreetventures.com

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [System Overview](#2-system-overview)
3. [Architecture](#3-architecture)
4. [Data Flow](#4-data-flow)
5. [Data Classification & Handling](#5-data-classification--handling)
6. [Authentication & Access Control](#6-authentication--access-control)
7. [Encryption & Cryptography](#7-encryption--cryptography)
8. [Network Security](#8-network-security)
9. [Infrastructure & Deployment](#9-infrastructure--deployment)
10. [Third-Party Integrations](#10-third-party-integrations)
11. [App Validation & Anti-Spoofing](#11-app-validation--anti-spoofing)
12. [HIPAA Alignment](#12-hipaa-alignment)
13. [Standards & Interoperability](#13-standards--interoperability)
14. [Dependency Overview](#14-dependency-overview)
15. [Risk Assessment & Mitigations](#15-risk-assessment--mitigations)
16. [Shared Responsibility Model](#16-shared-responsibility-model)
17. [Incident Response](#17-incident-response)
18. [Frequently Asked Questions](#18-frequently-asked-questions)

---

## 1. Executive Summary

Kill the Clipboard is a web-based tool that enables healthcare organizations to receive patient health records by scanning SMART Health Link (SHL) QR codes. It was developed in support of the CMS Kill the Clipboard initiative, which promotes digital health data exchange between patients and providers.

**Key security properties:**

- **No PHI storage on the server.** Patient health data is processed transiently in server memory, routed to the organization's configured destination, and discarded. Health records are never written to disk or persisted in the database.
- **End-to-end encryption of health data.** SMART Health Links use AES-256-GCM encryption. Data remains encrypted until decrypted in server memory during processing.
- **Multi-tenant isolation.** Each healthcare organization operates under its own URL, credentials, and configuration. No data is shared between organizations.
- **Standards-based.** Built on SMART Health Links, FHIR R4, and SMART Health Cards — the same interoperability standards mandated by ONC and adopted by major EHR vendors and health apps.

---

## 2. System Overview

### What It Does

1. A patient presents a SMART Health Link QR code from their health app (e.g., Apple Health, Epic MyChart, or any of the 83 CMS-approved apps).
2. A front-desk staff member scans the QR code using the organization's Kill the Clipboard scanner page on a tablet or computer.
3. The system decodes the SMART Health Link, retrieves and decrypts the patient's FHIR health data and/or PDF documents.
4. The extracted data is routed to the organization's configured destination (Google Drive, OneDrive, Box, email, or API endpoint).

### What It Does NOT Do

- Does not create, modify, or store patient health records
- Does not function as an EHR or clinical system
- Does not retain health data after delivery to the configured destination
- Does not require patients to create accounts or share login credentials
- Does not access the patient's health app or device

---

## 3. Architecture

### Component Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        Client (Browser)                         │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌───────────────┐  │
│  │  Camera   │  │  QR Code │  │  Results  │  │    Admin      │  │
│  │  Access   │  │  Decoder │  │  Display  │  │    Settings   │  │
│  └──────────┘  └──────────┘  └──────────┘  └───────────────┘  │
└────────────────────────────┬────────────────────────────────────┘
                             │ HTTPS (TLS 1.2+)
┌────────────────────────────▼────────────────────────────────────┐
│                     Application Server                          │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌───────────────┐  │
│  │   Auth    │  │   SHL    │  │   FHIR   │  │   Output      │  │
│  │  Module   │  │ Decoder  │  │ Extractor│  │   Router      │  │
│  └──────────┘  └──────────┘  └──────────┘  └───────────────┘  │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │              SQLite Database (config only)                │  │
│  │  • Organization settings    • OAuth refresh tokens       │  │
│  │  • Password hashes          • NO patient data            │  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
         │                    │                    │
         ▼                    ▼                    ▼
   ┌──────────┐       ┌──────────────┐     ┌───────────┐
   │  Cloud    │       │   Email      │     │  API /    │
   │  Storage  │       │   Services   │     │  FHIR     │
   │ (Drive,   │       │ (Gmail,      │     │  Server   │
   │  OneDrive,│       │  Outlook)    │     │           │
   │  Box)     │       │              │     │           │
   └──────────┘       └──────────────┘     └───────────┘
```

### Technology Stack

| Component | Technology | Version |
|-----------|-----------|---------|
| Runtime | Node.js | 20.x LTS |
| Web Framework | Express | 5.x |
| Database | SQLite (better-sqlite3) | Embedded |
| JWE/JWS Cryptography | jose | 4.x |
| Password Hashing | bcryptjs | 3.x |
| QR Code Processing | jsqr | 1.4 |
| Image Processing | sharp | 0.33 |
| Google APIs | googleapis | 171.x |
| Email (SMTP) | nodemailer | 8.x |

---

## 4. Data Flow

### QR Code Scan → Data Delivery

```
Step 1: QR Scan (Client-side)
  Browser camera captures QR code image
  jsqr library decodes QR code locally in the browser
  Extracted URL sent to server via HTTPS POST

Step 2: SHL Processing (Server-side, in memory)
  a. Parse SHL URI → extract manifest URL + AES-256 encryption key
  b. Fetch encrypted manifest from SHL server (outbound HTTPS)
  c. Decrypt JWE payload using AES-256-GCM
  d. Decompress if DEFLATE-compressed
  e. Parse FHIR Bundle(s) and/or extract PDF documents

Step 3: Data Routing (Server-side, in memory)
  Route extracted data to organization's configured destination:
  • Cloud storage: Upload via OAuth 2.0 API (Drive/OneDrive/Box)
  • Email: Send as attachment via OAuth 2.0 API (Gmail/Outlook)
  • API/Webhook: POST JSON payload to configured endpoint
  • Direct download: Stream back to browser as file download

Step 4: Cleanup
  All health data references in server memory become eligible
  for garbage collection. No data is written to disk or database.
```

### Data Flow Diagram — What Touches What

| Data Element | Browser | Server Memory | Server Disk/DB | Third-Party Destination |
|---|---|---|---|---|
| QR code image | ✅ Captured | ❌ | ❌ | ❌ |
| SHL URI / key | ✅ Decoded | ✅ Transient | ❌ | ❌ |
| Encrypted JWE | ❌ | ✅ Transient | ❌ | ❌ |
| Decrypted FHIR data | ✅ Displayed | ✅ Transient | ❌ | ✅ Delivered |
| Decrypted PDFs | ✅ Displayed | ✅ Transient | ❌ | ✅ Delivered |
| Org configuration | ❌ | ✅ | ✅ Persisted | ❌ |
| OAuth tokens | ❌ | ✅ | ✅ Persisted | ❌ |
| Password hashes | ❌ | ✅ | ✅ Persisted | ❌ |

---

## 5. Data Classification & Handling

### Data Categories

| Category | Examples | Classification | Storage | Retention |
|----------|---------|---------------|---------|-----------|
| Patient Health Data | FHIR Bundles, PDFs, demographics | **PHI** | In-memory only | Duration of HTTP request (~seconds) |
| SHL Encryption Keys | AES-256 key from QR code | **Sensitive Cryptographic Material** | In-memory only | Duration of HTTP request |
| Organization Credentials | Admin/staff password hashes | **Sensitive** | SQLite database | Until org deletion |
| OAuth Refresh Tokens | Google, Microsoft, Box tokens | **Sensitive** | SQLite database | Until disconnected or org deletion |
| Organization Settings | Name, slug, storage config | **Internal** | SQLite database | Until org deletion |

### PHI Handling Principles

1. **Transience:** Patient health data exists in server memory only for the duration of the scan-and-route operation (typically 2-5 seconds).
2. **No logging of PHI:** Health data content is never written to application logs. Error messages reference processing stage, not data content.
3. **No indexing:** Patient records are not searchable, queryable, or browsable within the system.
4. **No caching:** Health data is not cached in any server-side store (no Redis, no file cache, no session store).
5. **Memory-only processing:** All decryption, parsing, and extraction occurs in Node.js process memory with no intermediate disk writes.

---

## 6. Authentication & Access Control

### Dual-Password Model

Each organization has two independent authentication levels:

| Role | Access | Default Timeout | Purpose |
|------|--------|----------------|---------|
| **Admin** | Organization settings, integrations, password management | 24 hours | IT administrator or office manager |
| **Staff** | QR code scanner only | Configurable (1h / 4h / 8h / 12h / 24h) | Front-desk or clinical staff |

### Password Security

- **Hashing algorithm:** bcrypt with cost factor 10
- **Salting:** Automatic per-hash salt (bcrypt standard)
- **Plaintext storage:** Never — only bcrypt hashes are stored
- **Password requirements:** Minimum 6 characters (configurable by organization)

### Session Token Architecture

- **Format:** Custom compact token: `base64url(payload).HMAC-SHA256(payload)`
- **Signing key:** `SESSION_SECRET` environment variable (cryptographically random, set at deployment)
- **Payload contents:** Organization slug, role (admin/staff), organization ID, expiration timestamp
- **Token delivery:** Returned to client as JSON; stored in browser `localStorage`; sent as `Authorization: Bearer` header
- **Expiration:** Enforced server-side on every request; tokens cannot be extended without re-authentication
- **No sensitive data in tokens:** Tokens contain only organizational identifiers, never patient data

### Route Protection

- All API endpoints require valid authentication tokens via Express middleware
- Admin endpoints require `role: admin` in the token
- Staff endpoints accept either `admin` or `staff` roles
- Token slug must match the requested organization's slug (cross-tenant access denied)
- Public endpoints (registration, login, static assets) do not require authentication

---

## 7. Encryption & Cryptography

### Data in Transit

| Connection | Protocol | Enforcement |
|-----------|----------|-------------|
| Browser ↔ Application Server | HTTPS (TLS 1.2+) | Enforced by Fly.io edge proxy; `force_https = true` |
| Application Server ↔ SHL Server | HTTPS | Standard Node.js `fetch` with TLS verification |
| Application Server ↔ Google APIs | HTTPS | Required by Google API client libraries |
| Application Server ↔ Microsoft Graph | HTTPS | Required by Microsoft API endpoints |
| Application Server ↔ Box API | HTTPS | Required by Box API endpoints |

### Data at Rest (Health Records)

Health records are **not stored at rest** on the server. They exist only transiently in server memory.

### Data at Rest (Configuration)

| Data | Protection |
|------|-----------|
| Passwords | bcrypt hashed (cost factor 10) |
| OAuth refresh tokens | Stored in SQLite on encrypted volume (Fly.io volume encryption) |
| Session signing key | Environment variable, not stored in code or database |
| Database file | Resides on Fly.io persistent volume with filesystem-level access controls |

### Cryptographic Operations

| Operation | Algorithm | Library | Purpose |
|-----------|-----------|---------|---------|
| SHL payload decryption | AES-256-GCM (JWE) | jose | Decrypt patient health data |
| JWE key management | Direct (`dir`) | jose | Unwrap content encryption key |
| Password hashing | bcrypt (cost 10) | bcryptjs | Hash admin and staff passwords |
| Session token signing | HMAC-SHA256 | Node.js `crypto` | Sign/verify authentication tokens |
| SHC JWS decoding | Base64url + DEFLATE | Node.js `zlib` | Decode SMART Health Card payloads |

### Algorithm Restrictions

The JWE decryptor explicitly restricts accepted algorithms:
- Content encryption: `A256GCM` only
- Key management: `dir` (direct) only
- This prevents algorithm confusion/downgrade attacks

---

## 8. Network Security

### Inbound Traffic

- All HTTP traffic redirected to HTTPS (Fly.io `force_https`)
- TLS termination at Fly.io edge proxy
- Application listens on internal port 3000 (not directly exposed)
- No WebSocket connections
- No server-sent events

### Outbound Traffic

| Destination | Purpose | Protocol |
|-------------|---------|----------|
| SHL manifest servers (varies) | Fetch encrypted health data | HTTPS |
| accounts.google.com | OAuth 2.0 flows (Drive, Gmail) | HTTPS |
| login.microsoftonline.com | OAuth 2.0 flows (OneDrive, Outlook) | HTTPS |
| account.box.com | OAuth 2.0 flow (Box) | HTTPS |
| www.googleapis.com | Drive file upload, Gmail send | HTTPS |
| graph.microsoft.com | OneDrive upload, Outlook send | HTTPS |
| api.box.com | Box file upload | HTTPS |

### CORS & Browser Security

- Static HTML pages served for scanner, admin, registration
- API endpoints return JSON responses
- No cross-origin resource sharing (CORS) headers configured (same-origin only)
- Browser camera access requires HTTPS (enforced by browser security model)

---

## 9. Infrastructure & Deployment

### Hosting

| Parameter | Value |
|-----------|-------|
| Platform | Fly.io (PaaS) |
| Region | `iad` (US-East, Ashburn, Virginia) |
| Instance type | Shared CPU, 1 GB RAM |
| Operating system | Debian (node:20-slim container) |
| Minimum instances | 1 (auto-scale) |
| HTTPS enforcement | Yes, at edge |
| Data residency | United States |

### Persistent Storage

- **Type:** Fly.io persistent volume (`ktc_data`)
- **Mount point:** `/data`
- **Contents:** SQLite database file (`ktc.db`)
- **Contains:** Organization configuration, password hashes, OAuth refresh tokens
- **Does NOT contain:** Patient health data, FHIR records, PDFs, or any PHI

### Container Security

- **Base image:** `node:20-slim` (minimal Debian variant)
- **Dependencies:** Production only (`npm ci --omit=dev`)
- **Build:** Deterministic from lockfile (`npm ci`)
- **CI/CD:** GitHub Actions deploys to Fly.io on push to `main` branch

### Environment Variables (Secrets)

All sensitive configuration is stored as Fly.io secrets (encrypted at rest, injected at runtime):

| Variable | Purpose |
|----------|---------|
| `SESSION_SECRET` | HMAC key for session token signing |
| `GOOGLE_CLIENT_ID` | Google OAuth client identifier |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret |
| `ONEDRIVE_CLIENT_ID` | Microsoft OAuth client identifier |
| `ONEDRIVE_CLIENT_SECRET` | Microsoft OAuth client secret |
| `BOX_CLIENT_ID` | Box OAuth client identifier |
| `BOX_CLIENT_SECRET` | Box OAuth client secret |
| `PUBLIC_URL` | Application public URL for OAuth callbacks |

---

## 10. Third-Party Integrations

### OAuth 2.0 Integrations

Each integration uses the OAuth 2.0 Authorization Code flow with the minimum required scopes:

| Service | OAuth Provider | Scopes Requested | Data Access |
|---------|---------------|------------------|-------------|
| Google Drive | Google | `drive.file` | Create files/folders in authorized folder only |
| Gmail | Google | `gmail.send` | Send email only — no read/modify/delete access |
| OneDrive | Microsoft | `Files.ReadWrite.All`, `offline_access` | Create files/folders |
| Outlook | Microsoft | `Mail.Send`, `offline_access` | Send email only — no read/modify/delete access |
| Box | Box | `root_readwrite` | Upload files to specified folder |

### Token Lifecycle

1. **Authorization:** Admin initiates OAuth flow from the admin settings page
2. **Token exchange:** Authorization code exchanged for access + refresh tokens
3. **Storage:** Refresh token stored in SQLite database, scoped to the authorizing organization
4. **Usage:** Access tokens refreshed automatically when expired using stored refresh token
5. **Revocation:** Admin can disconnect any service at any time, deleting the stored refresh token
6. **Isolation:** Each organization's tokens are independent; no token sharing between organizations

### Minimum Privilege Principle

- **Google Drive:** `drive.file` scope — can only access files created by the application, not the user's entire Drive
- **Gmail / Outlook:** Send-only permissions — the application cannot read, search, modify, or delete existing emails
- **All services:** OAuth tokens are scoped to the specific account that authorized them

---

## 11. App Validation & Anti-Spoofing

Kill the Clipboard includes an optional app validation feature that allows organizations to verify a patient's health app is on the CMS-approved list before scanning their health data QR code.

### Current Implementation (Phase 1)

- Organizations can enable a two-step scan flow: first scan an app identity QR code, then scan the health data QR code
- App identity is checked against a list of 83 CMS-approved apps
- This is a **UX verification step** — it demonstrates the workflow but does not provide cryptographic proof of app identity
- Per-organization toggle: each organization chooses whether to require this step

### Production Roadmap (Phase 3)

The architecture for cryptographic app attestation has been designed and documented:

- **JWS-signed attestation tokens** using ES256 (ECDSA with P-256/SHA-256)
- **Dynamic QR codes** with timestamps, nonces, and 5-minute expiration
- **Signature verification** against public keys published in the CMS National Provider Directory via JWKS endpoints
- **Anti-spoofing protections:** Token expiration, cryptographic signatures, nonce-based replay prevention
- **Key management:** CMS issues signing keys to approved apps; apps store private keys in platform secure enclaves (iOS Keychain, Android Keystore)

This aligns with the SMART Health Cards cryptographic model and NIST-approved algorithms.

---

## 12. HIPAA Alignment

### How Kill the Clipboard Supports HIPAA-Compliant Workflows

| HIPAA Requirement | How Kill the Clipboard Addresses It |
|---|---|
| **Minimum Necessary** | Only processes data contained in the patient-presented QR code; does not access any additional records |
| **Access Controls** | Dual-password authentication; role-based access (admin vs. staff); configurable session timeouts |
| **Encryption in Transit** | All connections use HTTPS/TLS |
| **Encryption at Rest** | Health data is not stored at rest; organization secrets stored on encrypted infrastructure |
| **Audit Controls** | Each scan operation is a discrete, logged API request; OAuth token usage auditable via third-party provider logs |
| **Integrity** | FHIR data validated for structural integrity; AES-256-GCM provides authenticated encryption (tamper detection) |
| **Automatic Logoff** | Configurable session timeouts (1h / 4h / 8h / 12h / 24h) |
| **Unique User Identification** | Organizations identified by unique slug; admin and staff roles separated |

### Shared Responsibility

Kill the Clipboard is designed as a **data routing tool**, not a data storage system. HIPAA compliance is a shared responsibility:

| Responsibility | Owner |
|---|---|
| Health data transient processing security | Kill the Clipboard |
| HTTPS enforcement and network security | Kill the Clipboard + Fly.io |
| Authentication and session management | Kill the Clipboard |
| Multi-tenant data isolation | Kill the Clipboard |
| Business Associate Agreement with cloud storage provider | Subscribing organization |
| Email account HIPAA compliance (e.g., Google Workspace HIPAA BAA) | Subscribing organization |
| Staff training on scanner use | Subscribing organization |
| Physical security of scanning devices | Subscribing organization |
| Destination system access controls | Subscribing organization |
| API endpoint security (for webhook destinations) | Subscribing organization |

### Business Associate Agreement (BAA) Considerations

- When organizations route data to **Google Workspace** accounts, they should have a Google Workspace BAA in place
- When organizations route data to **Microsoft 365** accounts, they should have a Microsoft BAA in place
- **Box** offers BAA-eligible plans for healthcare organizations
- For **API/webhook** destinations, the receiving system's HIPAA compliance is the organization's responsibility
- Kill the Clipboard's transient processing model minimizes the scope of BAA requirements for the service itself

---

## 13. Standards & Interoperability

### Standards Implemented

| Standard | Usage |
|----------|-------|
| **SMART Health Links (SHL)** | Core protocol for QR code-based health data exchange |
| **FHIR R4** | Health data format for extracted clinical records |
| **SMART Health Cards (SHC)** | JWS-encoded verifiable health documents within SHL payloads |
| **JWE (RFC 7516)** | Compact serialization encryption for SHL data payloads |
| **JWS (RFC 7515)** | Signed tokens in SMART Health Cards and app attestation (Phase 3) |
| **OAuth 2.0 (RFC 6749)** | Authorization for all third-party service integrations |
| **AES-256-GCM (NIST SP 800-38D)** | Content encryption algorithm for JWE payloads |
| **ES256 / P-256 (FIPS 186-4)** | Signature algorithm for Phase 3 app attestation |
| **bcrypt** | Password hashing (adaptive cost function) |
| **HMAC-SHA256 (RFC 2104)** | Session token authentication |

### CMS Kill the Clipboard Program Alignment

- Supports all 12 early adopters and 71+ pledgee health apps in the CMS program
- App validation feature (optional) checks against the CMS-approved app list
- Scanner designed for the front-desk intake workflow described in CMS program materials
- Phase 3 app attestation architecture designed in coordination with CMS directory standards

---

## 14. Dependency Overview

All production dependencies are well-established, actively maintained open-source libraries:

| Package | Purpose | Weekly Downloads | License |
|---------|---------|-----------------|---------|
| express | Web server framework | ~34M | MIT |
| better-sqlite3 | Embedded database | ~1.2M | MIT |
| jose | JWE/JWS cryptography | ~9M | MIT |
| bcryptjs | Password hashing | ~2.5M | MIT |
| googleapis | Google Drive/Gmail API | ~3M | Apache-2.0 |
| sharp | Image processing for QR decode | ~5M | Apache-2.0 |
| jsqr | QR code decoding | ~600K | Apache-2.0 |
| nodemailer | SMTP email sending | ~3M | MIT |
| uuid | Unique identifier generation | ~60M | MIT |
| commander | CLI argument parsing | ~100M | MIT |

**No dependencies with known critical vulnerabilities** at time of writing.

---

## 15. Risk Assessment & Mitigations

| Risk | Severity | Likelihood | Mitigation |
|------|----------|-----------|------------|
| **PHI exposure via server compromise** | High | Low | PHI is never stored — only transient in memory. No disk persistence, no database storage of health records. Attacker would need active process memory access during a scan operation. |
| **OAuth token theft** | Medium | Low | Tokens stored in SQLite on encrypted Fly.io volume. Each token scoped to one organization. Revocable by admin at any time. |
| **Session token forgery** | Medium | Low | HMAC-SHA256 signed with cryptographically random secret. Token expiration enforced server-side. |
| **Password brute force** | Medium | Medium | bcrypt with cost factor 10 makes brute force computationally expensive (~100ms per attempt). |
| **QR code spoofing (app identity)** | Low | Medium | Phase 1 uses static list (spoofable). Phase 3 roadmap adds cryptographic attestation with JWS signatures. |
| **SQL injection** | High | Very Low | All database queries use parameterized statements. Column names validated against allowlist. |
| **Cross-tenant data access** | High | Very Low | Token-based slug verification on every request. Staff tokens cannot access other organizations' data. |
| **Decompression bomb (zip bomb via JWE)** | Medium | Low | 5 MB maximum decompression limit enforced on all inflate operations. |
| **SSRF via malicious SHL URL** | Medium | Low | SHL URLs originate from patient QR codes (controlled by legitimate health apps). Server makes outbound requests only to URLs from scanned QR codes. |

---

## 16. Shared Responsibility Model

```
┌──────────────────────────────────────────────────────────┐
│                  SUBSCRIBING ORGANIZATION                 │
│                                                          │
│  • Staff training and usage policies                     │
│  • Physical device security                              │
│  • Cloud storage BAA (Google/Microsoft/Box)              │
│  • Email account HIPAA compliance                        │
│  • API endpoint security                                 │
│  • Internal access control policies                      │
│  • Password management and rotation                      │
│  • Compliance documentation and auditing                 │
└──────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────┐
│                 KILL THE CLIPBOARD SERVICE                │
│                                                          │
│  • Application security (auth, encryption, isolation)    │
│  • Transient PHI processing (no storage)                 │
│  • Secure session management                             │
│  • OAuth integration security                            │
│  • HTTPS enforcement                                     │
│  • Input validation and sanitization                     │
│  • Dependency management and updates                     │
│  • Secure deployment pipeline                            │
└──────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────┐
│                  INFRASTRUCTURE (FLY.IO)                  │
│                                                          │
│  • TLS termination and certificate management            │
│  • Network isolation and DDoS protection                 │
│  • Volume encryption at rest                             │
│  • Physical data center security                         │
│  • Platform-level security patching                      │
│  • Secrets management (environment variables)            │
│  • US data residency (iad region)                        │
└──────────────────────────────────────────────────────────┘
```

---

## 17. Incident Response

### Data Breach Impact Assessment

Because Kill the Clipboard does not persistently store PHI:

- **A server breach would NOT expose historical patient records** — there are none on the server
- **A database breach would expose:** organization names, bcrypt password hashes, and OAuth refresh tokens
- **Impact of OAuth token exposure:** Attacker could upload files to connected cloud storage or send email from connected accounts until tokens are revoked
- **Mitigation:** Organizations can immediately disconnect services (revoking tokens) and change passwords from the admin page

### Recommended Organization-Level Response Procedures

1. Change admin and staff passwords immediately
2. Disconnect and reconnect all third-party service integrations (this rotates OAuth tokens)
3. Review recent files in connected cloud storage for unauthorized uploads
4. Review sent email in connected Gmail/Outlook accounts for unauthorized messages
5. Notify affected staff to clear browser sessions

---

## 18. Frequently Asked Questions

**Q: Does Kill the Clipboard store patient health records?**
A: No. Health data is processed in server memory only — it is never written to disk, stored in a database, or cached. Data exists in memory for the duration of the scan operation (typically 2-5 seconds) and is then discarded.

**Q: What data IS stored on the server?**
A: Only organization configuration: organization name, URL slug, bcrypt-hashed passwords, storage destination settings, and OAuth refresh tokens for connected cloud services.

**Q: Is health data encrypted?**
A: Yes, at every stage. SMART Health Links use AES-256-GCM encryption for the health data payload. Data remains encrypted until it is decrypted in server memory for processing. All network connections use HTTPS/TLS.

**Q: Can one organization access another organization's data?**
A: No. Every API request is validated against the authenticated organization's slug. Tokens are scoped to a specific organization, and the middleware rejects any cross-tenant access attempts.

**Q: Does Kill the Clipboard need a BAA?**
A: Kill the Clipboard's transient processing model (no PHI storage) limits the scope of BAA requirements. However, organizations should ensure they have appropriate BAAs with their cloud storage and email providers (Google Workspace, Microsoft 365, Box) since that is where health data is ultimately delivered and stored.

**Q: What happens if the server goes down during a scan?**
A: The scan operation fails and the health data in memory is released. No partial data is stored. The user can simply scan the QR code again once the service is restored.

**Q: Can Kill the Clipboard read our existing emails or cloud files?**
A: No. Gmail and Outlook integrations use send-only permissions. Google Drive uses `drive.file` scope which limits access to files created by the application only. The service cannot read, search, modify, or delete any existing data in connected accounts.

**Q: Where is the infrastructure located?**
A: The application runs on Fly.io in the `iad` region (Ashburn, Virginia, United States).

**Q: What authentication does the scanner page use?**
A: A staff password specific to each organization. Sessions are time-limited (configurable from 1 to 24 hours) and use HMAC-SHA256 signed tokens with server-side expiration enforcement.

**Q: Is the source code available for review?**
A: Yes. The project is open source and available at [github.com/Amy-at-CMS/killtheclipboard](https://github.com/Amy-at-CMS/killtheclipboard).

---

*This document is intended for CISO and compliance team review. For technical implementation details, see the project's [GitHub repository](https://github.com/Amy-at-CMS/killtheclipboard). For privacy policy, see [killtheclipboard.fly.dev/privacy](https://killtheclipboard.fly.dev/privacy).*
