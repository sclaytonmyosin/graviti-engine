#!/usr/bin/env node
// verify-attribution.mjs — verify a Graviti outbound-attribution token (gvt).
//
// Graviti tags every recommendation link to a brand's site with UTM parameters
// (utm_source=graviti, utm_medium=<surface>, utm_campaign=<category>,
// utm_content=<brand>) plus a signed `gvt` token, so the brand on the other
// side can PROVE the referral came from Graviti rather than take a spoofable
// UTM's word for it. Spec: docs/ATTRIBUTION.md.
//
// Token format:
//   gvt1.<surface>.<category>.<brand>.<YYYYMMDD>.<signature>
// The signature is the untruncated base64url (no padding) Ed25519 signature
// over the UTF-8 bytes of everything before the final dot, made with the same
// key that signs the integrity ledger. The date is the token's ISSUE date
// (when the batch was signed at build), not a click time — tokens identify
// the recommendation surface, never a user.
//
// Usage (paste a bare token or a full landing URL):
//   node scripts/verify-attribution.mjs 'gvt1.agent.magnesium-supplements.bioptimizers.20260829.<sig>'
//   node scripts/verify-attribution.mjs 'https://brand.com/?utm_source=graviti&...&gvt=gvt1....'
//
// Exit 0 only if the signature verifies against the pinned key. No
// dependencies beyond Node ≥ 20. Equivalent openssl check in docs/ATTRIBUTION.md.
import { createPublicKey, verify as edVerify } from "node:crypto";

// PINNED Graviti signing key (Ed25519, SPKI base64) — the same pin as
// verify-payload.mjs and the committed data/public-key.pem. Pinning is the
// point: don't trust a served key alone to verify a claim about its owner.
const PINNED_PUBLIC_KEY_B64 = "MCowBQYDK2VwAyEAPYznSNiELA8x6Eym7rk50GExv63QJeupB9uQQCOh7Ck=";

const arg = process.argv[2];
if (!arg) {
  console.error("usage: node scripts/verify-attribution.mjs <gvt token | full URL containing ?gvt=...>");
  process.exit(2);
}

let token = arg.trim();
if (token.includes("://")) {
  try {
    const fromUrl = new URL(token).searchParams.get("gvt");
    if (!fromUrl) {
      console.error("FAIL: the URL carries no gvt parameter — UTM-only link, or not a Graviti-attributed link.");
      process.exit(1);
    }
    token = fromUrl;
  } catch {
    console.error("FAIL: argument is neither a parseable URL nor a bare token.");
    process.exit(1);
  }
}

const parts = token.split(".");
if (parts.length !== 6 || parts[0] !== "gvt1") {
  console.error(
    `FAIL: malformed token — expected gvt1.<surface>.<category>.<brand>.<YYYYMMDD>.<signature>, got ${parts.length} segment(s), version '${parts[0]}'.`
  );
  process.exit(1);
}
const [, surface, category, brand, issued, signature] = parts;
const payload = parts.slice(0, 5).join(".");

const pubKey = createPublicKey(
  `-----BEGIN PUBLIC KEY-----\n${PINNED_PUBLIC_KEY_B64}\n-----END PUBLIC KEY-----\n`
);
let ok = false;
try {
  ok = edVerify(null, Buffer.from(payload, "utf8"), pubKey, Buffer.from(signature, "base64url"));
} catch {
  ok = false;
}

if (!ok) {
  console.error("FAIL: signature does not verify against the pinned Graviti public key.");
  console.error("      A token that fails here was NOT minted by Graviti (or was altered in transit).");
  process.exit(1);
}

console.log("PASS: Ed25519 signature verifies against the pinned Graviti public key.");
console.log(`      surface:  ${surface}  (which Graviti surface produced the link — 'agent' = an AI agent via MCP)`);
console.log(`      category: ${category}`);
console.log(`      brand:    ${brand}`);
console.log(`      issued:   ${issued.slice(0, 4)}-${issued.slice(4, 6)}-${issued.slice(6)}  (token batch issue date, not a click time)`);
console.log("      Contains no user identifiers, click IDs, or session data — by construction.");
