# Agora Mesh Landing

Static landing page for Agora Mesh (visual template adapted from the private
`Kris77z/chaindo-landing` repo with the author's permission — particles, scroll
choreography and CRT terminal kept; all copy, links and terminal content replaced).

The second-screen terminal is an **evidence replay**: service ids, prices,
settlement counts and the revoke negative test mirror the frozen BNB Testnet
evidence in `../evidence/`. It is labeled `FEED: EVIDENCE REPLAY · MODE: READ-ONLY`
and does not fabricate live data.

## Local preview

No npm install or build step. JavaScript uses ES modules, so serve over HTTP:

```sh
python3 -m http.server 3010 --bind 127.0.0.1
```

Open http://127.0.0.1:3010 .

## Deployment

Serve this directory as the site root (`/`) and reverse-proxy every other path
(`/marketplace`, `/compare`, `/advantage`, `/authority`, `/authority/manage`,
`/dashboard`, `/tasks/*`, `/api/*`) to the Next.js app. All internal links here
use absolute paths on the same origin. The Caddy config in `../deploy/` is the
intended place to wire this up.
