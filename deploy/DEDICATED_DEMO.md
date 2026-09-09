# Dedicated demo deployment

Authorized target: `43.165.167.118`, Tencent Lighthouse Tokyo, Ubuntu 24.04, 2 CPU / 4 GB.
The former deployment target remains prohibited; `activate-fixed-host.sh` stays disabled.

Deploy the production Next.js frontend, Hunter, Registry, four specialist profiles
(Auditor, Sentinel, Verifier, Investigator), Caddy HTTPS, and persistent task stores.
LLM inference uses the configured external API. Slither runs on this machine.
This is a demo capacity target, with no high-concurrency benchmark claim.

`bootstrap-demo.sh` installs Node 22 from the official distribution with its SHA-256
manifest, Ubuntu packages, and the app directories. It must run only on this server.
It does not upload keys, activate the app, or broadcast blockchain transactions.

Required secrets belong in `/srv/agora-mesh/config/*.env` with restricted access.
Only necessary model keys and testnet specialist/facilitator keys should be transferred.
Do not copy the SSH private key, owner/admin wallet keys, or historical user session keys.
Public frontend variables must not contain service API tokens or private keys.

Status at 2026-09-09 12:45 Beijing time:

- Node 22.23.2 and npm 10.9.8 installed; production Next.js build passed on the server.
- Slither 0.11.6 and solc 0.8.28 installed. Build peak memory: 2.9 GB (systemd).
- Revision `01ac84aac7c34f3ef8d199affdb7600fe54c43a5` activated under `/srv/agora-mesh/current`.
- Nine restricted environment files transferred using an encrypted CMS envelope;
  the private decryption key was generated on the target server. No plaintext
  credential values were put in cloud command records.
- Seven app systemd units enabled. Hunter, Registry, and all four specialist health checks pass; all specialist heartbeats succeed and Slither is available.
- Caddy configuration validated; trusted certificates issued for the website and specialist subdomains. External HTTPS was verified reachable on 2026-09-09 at 13:39 Beijing time.
- Intended temporary origin: `https://43-165-167-118.sslip.io`.
- Public HTTP API exposes browser Authority operations and evidence. Legacy Hunter
  `/run` endpoints remain internal; use `/authority/manage` to start a paid task.
- SSH remains unavailable over the current local network; Tencent TAT was used.

Server-side HTTPS checks pass for the six product pages, Authority configuration,
service listing, comparison POST, all specialist health endpoints, and Altana RPC /
Relay read calls. TCP 443 is now externally reachable; full paid browser acceptance still requires the model configuration.
The same-origin check now uses the fixed `AGORA_PUBLIC_ORIGIN` behind the TLS proxy;
8 relevant tests and frontend type checking passed, followed by a successful server build.

Model API check: the configured China endpoint timed out from Tokyo; the global
endpoint responded 401 to this key. Model execution is not yet accepted. Health's
`llm.available` indicates a configured key, not verified inference availability.
Do not report a fully working public hiring demo until model connectivity is resolved.

All nine env files have mode 0600 and owner root. Temporary local env copies and
the one-time server envelope decryption key/certificate were removed after import.

`build-demo.sh <40-character-commit>` and `activate-dedicated-demo.sh <commit>`
are initial-deployment helpers; they refuse to overwrite an existing release/current
link. The active first deployment was made from 01ac84a with the HTTPS-origin fix
applied before rebuilding. `AGORA_PUBLIC_ORIGIN` must match the external HTTPS origin.
The compiled server runs its model inference through the external provider API.
Service endpoints use individual subdomains because discovery validates origin URLs.
Same-host routing is pinned in `/etc/hosts` for the public hostname and four service
subdomains; external DNS continues to point to the dedicated public IP.
