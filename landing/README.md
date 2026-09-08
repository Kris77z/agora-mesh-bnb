# Agora Mesh Landing

Static landing page for Agora Mesh (visual template adapted from the private
`Kris77z/chaindo-landing` repo with the author's permission — particles, scroll
choreography and CRT terminal kept; all copy, links and terminal content replaced).

The second-screen terminal is an **evidence replay**: service ids, prices,
settlement counts and the revoke negative test mirror the frozen BNB Testnet
evidence in `../evidence/`. It is labeled `FEED: EVIDENCE REPLAY · MODE: READ-ONLY`
and does not fabricate live data.

## App preview and deployment

From the repository root, run `npm run dev --workspace @rebel/frontend`, or build and start the frontend. Open http://localhost:3000.

The frontend predev/prebuild step copies this canonical source to generated public assets. Next.js serves the landing page at `/`; marketplace, compare, evidence and Authority actions stay on the same application origin. The final call to action opens `/authority/manage`. No separate static server or cross-origin localhost links are needed.
