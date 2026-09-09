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

Model configuration updated 2026-09-09 at 14:43 Beijing time: Hunter and all four
specialists use the OpenAI-compatible endpoint `https://gateway.llmgtw.io/v1`,
model `gemini-3.1-pro-preview`. The key is stored only in restricted server env
files; it was transferred with RSA-OAEP encryption using a temporary server key,
which was deleted after import. Kimi credentials are disabled in these profiles.
All five public health checks return 200. The health provider label `openai`
means the compatible transport, not an OpenAI-hosted model.

Patch `7ba7072` was applied to the active server release: seven SDK generation
calls now set `maxRetries: 0` and `maxTokens: 4096`. This is a requested output
budget, not a guaranteed billing cap; the gateway has returned more completion
tokens than requested in probes. Hunter retains the existing scripted mode.

The first server probe using the actual AI SDK returned HTTP 200 with an empty
answer and no tool call (538 total tokens; gateway-reported USD 0.003056).
Model connectivity is verified, but a fully working paid hiring flow is not yet
accepted. Do not treat configured-key health or a short local probe as full
production model acceptance.

All nine env files have mode 0600 and owner root. Temporary local env copies and
the one-time server envelope decryption key/certificate were removed after import.

`build-demo.sh <40-character-commit>` and `activate-dedicated-demo.sh <commit>`
are initial-deployment helpers; they refuse to overwrite an existing release/current
link. Use `update-dedicated-demo.sh <40-character-commit>` for every subsequent
release: it builds beside the running one, keeps `state/registry` and `state/memory`
linked rather than reseeded, swaps `current` only after the build produces a
BUILD_ID, restarts the seven units, and prints a rollback command. SSH to this host
is closed by network interference on the operator's connection, so run it from the
Tencent console's command panel. The active first deployment was made from 01ac84a with the HTTPS-origin fix
applied before rebuilding. `AGORA_PUBLIC_ORIGIN` must match the external HTTPS origin.
The compiled server runs its model inference through the external provider API.
Service endpoints use individual subdomains because discovery validates origin URLs.
Same-host routing is pinned in `/etc/hosts` for the public hostname and four service
subdomains; external DNS continues to point to the dedicated public IP.

Second server SDK probe explicitly selected the multiply tool, with a 128-token
output request: HTTP 200, text `Format`, no tool execution, 293 total tokens,
gateway-reported USD 0.00158. Two actual server inference requests consumed 831
tokens and USD 0.004636 in reported charges. No further paid probes were run.
The server SDK probes used its `maxTokens` option; the successful local raw probe
used `max_completion_tokens`. Their request shapes and output budgets are not
proven equivalent. Long-form/task completion and gateway parameter compatibility
remain unverified. Temporary probe files were removed.


## Gemini compatibility acceptance — 2026-09-09 14:57 Beijing

Patch `f6c0e43` is deployed to the active server release. All seven SDK provider
instances use the shared llmgtw adapter. Only the exact gateway origin/path and
`gemini-3.1-pro-preview` are adapted: non-streaming JSON, `max_tokens` mapped to
`max_completion_tokens`, and temperature omitted to match the successful raw
probe. The adapter performs one transport attempt and rejects redirects. Other
providers and models are unchanged. Five offline tests passed locally and on the
server, including the existing SDK's tool-result round trip; three workspace
type checks passed locally.

The actual server SDK then autonomously called a local multiplication tool and
answered `391`: two requests, one tool execution, 558 total tokens, gateway-reported
USD 0.002494. This supersedes the failed minimal SDK probes above for the adapted
request format. It does not establish long-context reliability or full paid
browser-task acceptance. No blockchain transaction was sent by the probe.
