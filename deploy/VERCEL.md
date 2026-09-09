# Vercel frontend

Project: `agora-mesh-bnb` in `jiangziyi-yongtuios-projects`.
Git repository: `Kris77z/agora-mesh-bnb`, production branch `main`.
Root directory: `frontend`; framework: Next.js; build: `npm run build`.
Keep repository files outside the root available: the prebuild script copies
`landing/` into `frontend/public/site/`.

Production environment (these are endpoint settings, not credentials):

```dotenv
HUNTER_INTERNAL_URL=https://43-165-167-118.sslip.io/api/hunter
REGISTRY_INTERNAL_URL=https://43-165-167-118.sslip.io/api/registry
WRITER_INTERNAL_URL=https://43-165-167-118.sslip.io/api/auditor
ALTANA_BRIDGE_ORIGIN=https://43-165-167-118.sslip.io
NEXT_PUBLIC_DEMO_MODE=false
```

Browser API requests use same-origin `/api/*` routes. Backend URLs are also
used by server-rendered pages. Changing rewrite destinations requires a rebuild.
The dedicated backend's `CORS_ALLOWED_ORIGINS` includes
`https://agora-mesh-bnb.vercel.app`; preview origins are not automatically allowed.

The Altana route validates the browser origin and method, then sends one request
to the dedicated server bridge. It never retries the hosted forwarding request,
including signed submissions whose outcome is unknown. The server bridge retains
its existing transport recovery policy. No model or wallet keys belong in Vercel
public environment variables. Model inference and agent persistence remain on
the dedicated server.

A new website origin does not inherit localhost Passkeys or Authority browser
storage. A working frontend deployment does not prove a fresh paid task completed;
model connectivity and device-approved authorization must be verified separately.

Verified 2026-09-09, Beijing time: production deployment `95ee271` is Ready at
https://agora-mesh-bnb.vercel.app . Six main pages returned HTTP 200, as did Hunter
health, browser Authority configuration and the Registry service list. The hosted
Altana bridge returned JSON-RPC results for `eth_chainId` and
`wallet_getCapabilities`. Chrome rendered all five live service listings.
No new paid execution or device signing was performed in this deployment check.
