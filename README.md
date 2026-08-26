# graviti-engine

The deterministic scoring engine behind [Graviti](https://graviti.thesingulariti.ai) — trust infrastructure for agent-mediated commerce, built by Singulariti. This repository exists so the site's central claim ("scoring is open to audit") is checkable, not just stated: [`src/engine.ts`](src/engine.ts) here is the exact module that ranks every recommendation in production — the MCP server, the web console, and the public endpoints all import this one file. There is no private ranking path.

## The two laws

1. **Verification is paid. Ranking is never paid.** Brands pay for continuous independent auditing of their claims. Verification status carries zero weight in ranking — read the fit-score construction in `matchIntent()` and confirm no payment signal enters it.
2. **Payment buys speed, never outcome.** A brand can pay to fast-track a re-evaluation; payment compresses the clock, never the verdict.

The only score adjustments tied to a brand's standing are the fixed, disclosed lifecycle penalties (`LIFECYCLE_PENALTY`: flagged −0.05, degraded −0.15) — driven by monitored quality signals, never by payment status — and revoked brands are excluded from scoring entirely.

## What you can verify by reading this code

- **Scoring is deterministic.** Pure functions over a brand index — no I/O, no network, no randomness, no learned parameters. The engine's only inputs are the index, the question text, and an optional intent profile. Same inputs, same scores, every time.
- **Conversion data never enters scoring.** The engine has no conversion input — grep this file for anything conversion-shaped and you'll find nothing. Attributed-conversion events exist in the private transport layer purely as billing records (pay-on-real-acquisition); they are structurally incapable of reaching a fit score because this module never sees them.
- **Scores are reproducible from public data.** The full index this engine runs over in production is public. Point the engine at it and you reproduce production scores exactly:
  - https://graviti.thesingulariti.ai/index.json — manifest (totals, disclosure, category list)
  - https://graviti.thesingulariti.ai/index-full.json — the complete index in one fetch; this is the exact content the integrity ledger hashes
  - https://graviti.thesingulariti.ai/ledger.json — append-only, hash-chained, Ed25519-signed, Bitcoin-anchored version history
- **Every payload carries structural disclosure.** See `disclosure()`: `rank_influenced_by_payment: false`, who paid, who didn't, and what payment buys — machine-readable, on every response.
- **Out-of-scope questions get a refusal, never a guess.** See the `in_index: false` branch of `matchIntent()`.

## Run it

```bash
npm install
npm run demo -- "best magnesium supplement"
npm run demo -- "cheapest cold plunge with a chiller"
npm run demo -- "best magnesium supplement" --json     # the full machine payload agents receive
```

The demo runs the engine over [`data/sample-index.json`](data/sample-index.json), a small real slice of the public index (five categories, ~100 brands, with claims, provenance URLs, and the accountability log). For the complete picture, fetch [index-full.json](https://graviti.thesingulariti.ai/index-full.json) and substitute it — the engine takes any `BrandIndex`.

## Verify the ledger

The index's version history is a hash chain: each entry commits to the SHA-256 of the canonical full-index content and the previous entry's hash, is Ed25519-signed against the published public key ([`data/public-key.pem`](data/public-key.pem), also served at [/public-key.pem](https://graviti.thesingulariti.ai/public-key.pem)), and is anchored to Bitcoin via OpenTimestamps. Rewriting any historical entry breaks every hash after it — even Graviti cannot edit the record.

```bash
npm run verify:ledger           # verifies the committed ledger snapshot, then checks it against the live index
npm run verify:ledger -- --live # fetches and verifies the current live ledger instead
```

The script needs no secrets and no Graviti-run infrastructure: it recomputes every entry hash, walks the chain back to genesis, and checks every signature against the public key. Bitcoin anchors can be independently replayed with the open-source OpenTimestamps client against proofs at `/ots/v<N>.ots` — instructions in [llms.txt](https://graviti.thesingulariti.ai/llms.txt).

## Verify what you received — transport integrity

The ledger proves what was *published*. It cannot see the pipe: TLS-terminating proxies, CDNs, caches, and load balancers sit between Graviti's origin and your process, and any of them could alter a payload with no ledger entry capturing the delta. From ledger v25, every entry's signed core pins a sha256 manifest of every published payload (`files.artifacts`), so the check moves to your side of the pipe. **Verify before trust:**

```bash
npm run verify:payload                                             # /index-full.json
npm run verify:payload -- /index.json /data/categories/magnesium-supplements.json /llms.txt
```

`scripts/verify-payload.mjs` is dependency-free (Node ≥ 20) and exits nonzero on any failure. It:

1. fetches the ledger from **two independent paths** — this repo's snapshot on raw.githubusercontent.com and the origin's `/ledger.json` — verifies both chains, and cross-checks the heads (a fork or an origin serving an older ledger than the public mirror fails loudly);
2. verifies every Ed25519 signature against the **pinned** signing key embedded in the script — the served `/public-key.pem` is cross-checked against the pin and a mismatch is a failure, never a source of trust;
3. recomputes the sha256 of the payload you actually received and compares it to the head entry's signed manifest;
4. guards against replay: a payload that matches an **older** entry's manifest instead of the head is stale-but-validly-signed — reported as its own failure, because a replayed yesterday is the subtle attack.

No Node? The core check is two commands with `curl`, `jq`, and `sha256sum` — expected hash from the mirror snapshot (independent path), actual hash from the bytes that reached you:

```bash
curl -s https://raw.githubusercontent.com/sclaytonmyosin/graviti-engine/main/data/ledger.json \
  | jq -r '.entries[-1].files.artifacts["/index-full.json"]'
curl -s https://graviti.thesingulariti.ai/index-full.json \
  | jq -cjS 'del(.generated_at, .integrity)' | sha256sum
```

The two hashes must match. (JSON payloads are hashed in canonical form — recursively sorted keys, no whitespace — after deleting the two volatile envelope fields `generated_at` and `integrity`, which carry the build timestamp and the pinning entry's own hash and so cannot be inside the pinned content. `/llms.txt` is hashed as exact bytes, no `jq` step.) For the full guarantee, also confirm the mirror and origin ledgers agree and the signature chain verifies — that's steps 1–2 above, or `npm run verify:ledger`.

**The boundary, honestly:** a passing check proves the bytes that reached the edge of your process match Graviti's signed, Bitcoin-anchored record. Nothing cryptographic reaches *inside* your runtime or a model's context window after verification passes — if your own stack mutates the data afterwards, no publisher-side mechanism can see it. Verify as close to the point of use as you can; the last hop is yours.

## Sync provenance

`src/engine.ts`, `scripts/verify-ledger.mjs` (modulo the live-fetch adaptation noted in its header), `data/ledger.json`, and `data/public-key.pem` mirror the private Graviti monorepo at commit `cf24943` (2026-08-26). The engine file is verbatim — re-syncing is a file copy plus an update to this line, and it now happens automatically with every ledger snapshot sync. This sync carries the rubric-pinning release: from ledger v26 every entry's signed core carries a `rubric` field — the sha256 and git blob sha1 of the exact committed `src/engine.ts` that scored every ranking published under that entry, plus the pinning private-repo commit and this repository's URL. That makes the sync provenance *checkable instead of stated*:

```bash
# The engine in this repo must hash to exactly what the signed ledger head pins:
git hash-object src/engine.ts
curl -s https://graviti.thesingulariti.ai/ledger.json | jq -r '.entries[-1].rubric.engine_git_blob_sha1'
# — the two must match byte for byte. Equivalently, with no git:
sha256sum src/engine.ts   # must equal .entries[-1].rubric.engine_sha256
```

The blob hash is computed by `git hash-object` over the raw committed file bytes (no normalization), so any checkout of this mirror — or of the private repo at the pinned commit — reproduces it. A scoring change is therefore a public, diffable event: the ledger entry that ships it pins the new hash, and this file's history shows the diff. If this repo's engine ever fails that check, the mirror is out of sync (or you're comparing against a ledger newer than your checkout) — `npm run verify:ledger` performs the same cross-check and says which. This release also ships the claim-decay classes: the per-claim freshness policy (`CLAIM_DECAY_CLASSES` / `CLAIM_DECAY_RULES` in the engine — fast 45d, medium 120d, slow 365d, static) under which a claim past its disclosed window is marked "stale — pending re-verification" on every payload and counts at half weight where claim depth feeds scoring — visibly degraded, never zeroed, because stale is not false.

## Layout

```
src/engine.ts            the engine — types, laws, scoring, disclosure (verbatim production module)
data/sample-index.json   real slice of the public index so the demo runs offline
data/ledger.json         committed snapshot of the public integrity ledger
data/public-key.pem      Ed25519 public key the ledger signatures verify against
demo/run.ts              CLI demo — question in, ranked disclosure-carrying answer out
scripts/verify-ledger.mjs  no-secrets ledger verification (chain, signatures, live index hash)
scripts/verify-payload.mjs client-side transport-integrity check — pinned key, two ledger paths, replay guard
```

## License

[Apache-2.0](LICENSE) — Copyright 2026 Singulariti.
