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

## Sync provenance

`src/engine.ts`, `scripts/verify-ledger.mjs` (modulo the live-fetch adaptation noted in its header), `data/ledger.json`, and `data/public-key.pem` mirror the private Graviti monorepo at commit `6282b4b` (2026-08-25). The engine file is verbatim — re-syncing is a file copy plus an update to this line. Scoring changes land here in the same change that ships them to production; an evidence-states gate is the next scheduled engine change.

## Layout

```
src/engine.ts            the engine — types, laws, scoring, disclosure (verbatim production module)
data/sample-index.json   real slice of the public index so the demo runs offline
data/ledger.json         committed snapshot of the public integrity ledger
data/public-key.pem      Ed25519 public key the ledger signatures verify against
demo/run.ts              CLI demo — question in, ranked disclosure-carrying answer out
scripts/verify-ledger.mjs  no-secrets ledger verification (chain, signatures, live index hash)
```

## License

[Apache-2.0](LICENSE) — Copyright 2026 Singulariti.
