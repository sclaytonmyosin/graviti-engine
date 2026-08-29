# Outbound attribution — UTMs + signed gvt tokens

Whenever Graviti produces a recommendation link to a brand's own site, the link is tagged so the brand can see — in its own analytics, on its own side of the fence — that the traffic came from a Graviti recommendation, and can **verify that claim cryptographically** instead of trusting a spoofable UTM string. This closes the attribution loop that `report_conversion` (pay-on-real-acquisition) needs: a conversion event can now carry verifiable provenance of the recommendation that caused it.

Attribution applies to the brand's **main site/product link only**. Claim provenance URLs are receipts and stay byte-exact — attribution never touches them.

## The canonical UTM scheme

Deterministic, the same on every surface:

| Parameter | Value |
|---|---|
| `utm_source` | `graviti` — always |
| `utm_medium` | the **surface**: `agent` (MCP tool results — recommendations delivered through an AI agent), `console`, `scan`, `landscape`, `report` (gap-report portal pages) |
| `utm_campaign` | the category slug, e.g. `magnesium-supplements` |
| `utm_content` | the brand slug in the index, e.g. `bioptimizers` |
| `gvt` | the signed token (below) |

Example:

```
https://bioptimizers.com/?utm_source=graviti&utm_medium=agent&utm_campaign=magnesium-supplements&utm_content=bioptimizers&gvt=gvt1.agent.magnesium-supplements.bioptimizers.20260829.<86-char signature>
```

In GA4 this shows up as `session_source = graviti` with medium/campaign/content telling you exactly which surface, category, and index entry sent the visit.

## The gvt token

```
gvt1.<surface>.<category>.<brand>.<YYYYMMDD>.<signature>
```

- Dot-separated; slugs never contain dots, so parsing is unambiguous.
- `<signature>` is the **untruncated** Ed25519 signature (64 bytes, base64url without padding — 86 characters) over the UTF-8 bytes of everything before the final dot (`gvt1.<surface>.<category>.<brand>.<YYYYMMDD>`). No truncation: a full signature costs ~86 URL characters and buys an unqualified verification story.
- Signed with the **same Ed25519 key that signs the integrity ledger** — public key published at `https://graviti.thesingulariti.ai/public-key.pem` and pinned in this repo (`data/public-key.pem`).
- `<YYYYMMDD>` is the token's **issue date** — the UTC date the token batch was signed at build time — not a click timestamp. Stated plainly: the token cannot tell you *when* a visitor clicked, only *which recommendation surface* their link was minted for and approximately when it was minted.

### Why build-time pre-signing (the trust model, stated honestly)

No Graviti runtime holds the private key. The stdio MCP server runs on users' machines; the hosted MCP endpoint is a serverless function; the web app is static client-side code — none of them can sign, and none of them should. The population of (category, brand) pairs is known at build, so `scripts/gen-attribution.mjs` pre-signs every token during the release build (the same build step that signs the ledger), and every surface ships or serves the pre-signed tokens as data:

- MCP tools (stdio + hosted) read `data/attribution-tokens.json` and return `attributed_url` alongside the raw `site_url`.
- The web app reads the `attribution` block each public category file carries beside the category object.

Consequence, stated honestly: **every surface has the same signature strength** — there is no "server-signed vs client-unsigned" tier, because nothing signs at request time. What a valid token proves: *Graviti minted an outbound link for this (surface, category, brand) on this date.* What it cannot prove: that a particular click actually traversed that link (anyone can copy a public URL, and the same token is served to every visitor of the same surface — that's the privacy design working as intended). For conversion-grade attribution, the token is one leg; the platform-co-attested standard `report_conversion` documents remains the endgame.

### Idempotency and the ledger

Ed25519 signatures are deterministic (RFC 8032), and existing pairs keep their issue date, so regenerating tokens over an unchanged brand population is byte-identical — a rebuild never churns the ledger. Category files (which embed the tokens) are pinned by each ledger entry's `files` manifest; the `attribution` block sits **beside** the category object, never inside it, so the documented index-hash reproduction (`jq -cjS '{accountability_log, categories}'` over `/index-full.json`) is unchanged.

## Verify a token (for brands)

You received traffic with `utm_source=graviti` and want proof. Take the `gvt` parameter from the landing URL.

**One command (Node ≥ 20, no dependencies):**

```
node scripts/verify-attribution.mjs 'gvt1.agent.magnesium-supplements.bioptimizers.20260829.<sig>'
# or paste the full landing URL — the script extracts the gvt parameter
```

**Or with openssl:**

```bash
TOK='gvt1.agent.magnesium-supplements.bioptimizers.20260829.<sig>'
printf '%s' "${TOK%.*}" > payload                     # everything before the last dot
printf '%s==' "${TOK##*.}" | tr '_-' '/+' | base64 -d > sig   # base64url → raw 64-byte signature
curl -sO https://graviti.thesingulariti.ai/public-key.pem
openssl pkeyutl -verify -pubin -inkey public-key.pem -rawin -in payload -sigfile sig
# → "Signature Verified Successfully"
```

Cross-check the served key against the pinned copy in this repo (`data/public-key.pem`) — the same key verifies the integrity ledger, so a forged key would have to fork the entire signed history to stay consistent.

## Privacy stance (structural, not policy)

The token identifies the **recommendation surface, never the user**:

- No user identifiers, no click IDs, no session data, nothing per-visitor — every visitor from the same surface carries the byte-identical token.
- No click logging of end users: Graviti's only demand-side telemetry remains the existing aggregate demand counters (category + topic keyword + intent, no verbatim questions, no identities).
- Timestamp granularity is deliberately coarse (issue date), so the token cannot be used to correlate individuals.

Graviti does not track the brand's customers; it tags its own referrals.

## Closing the loop: report_conversion

`report_conversion` accepts an optional `gvt` field (backwards-compatible — existing callers are unaffected). When supplied, the server verifies the signature against the published key and records the verdict with the event (`recommendation_attribution`: token, `signature_valid`, and the bound surface/category/brand/issue date; a brand mismatch between token and reported `brand_id` is recorded, not rejected — the dispute trail is the product). A reported conversion can therefore carry verifiable provenance of the recommendation that originated it.

## Where things live

- `src/attribution.ts` — the one shared module (URL construction, token format, pinned public key). Pure by design: the web bundles it; signing/verification live where runtimes can hold keys.
- `scripts/gen-attribution.mjs` — build-time signer → `data/attribution-tokens.json` (committed).
- `src/tools.ts` — `attributed_url` on `match_intent` / `get_verified_claims` / `category_landscape`; `gvt` verification in `report_conversion`.
- `web/scripts/lib/payloads.mjs` — embeds each category's token slice into its public category file.
- `scripts/verify-attribution.mjs` — the brand-side verifier (also in the public mirror).
