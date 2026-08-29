/**
 * Graviti outbound attribution — the shared URL/token module.
 *
 * Whenever Graviti produces a recommendation link to a brand's own site, the
 * link carries deterministic UTM parameters plus a signed `gvt` token, so the
 * brand can see in its own analytics that the traffic came from Graviti — and
 * can VERIFY that claim cryptographically against the published Ed25519 key
 * (the same key that signs the integrity ledger). Bare UTMs are spoofable;
 * the token is not.
 *
 * One implementation for every surface: the MCP tools (src/tools.ts), the
 * build-time token signer (scripts/gen-attribution.mjs), the public payload
 * builder (web/scripts/lib/payloads.mjs), and the web app all construct
 * attributed URLs through this module. It is deliberately pure — no node
 * imports — because the web bundles it; signing and verification live where
 * a runtime can hold keys (build scripts, server-side tools).
 *
 * The privacy stance, structural: a token identifies the RECOMMENDATION
 * SURFACE (which Graviti surface, which category, which brand, which UTC
 * issue date) — never the user. No user identifiers, no per-click values,
 * no session data. Every token for the same (surface, category, brand,
 * issue date) is byte-identical for every visitor, by construction.
 *
 * Token format (`gvt` query parameter):
 *   gvt1.<surface>.<category>.<brand>.<YYYYMMDD>.<signature>
 * where <signature> is the UNTRUNCATED base64url (no padding) Ed25519
 * signature over the UTF-8 bytes of everything before the final dot
 * (`gvt1.<surface>.<category>.<brand>.<YYYYMMDD>`). Slugs never contain
 * dots, so splitting on "." is unambiguous. Full spec: docs/ATTRIBUTION.md.
 *
 * Signing is build-time only: the population of (category, brand) pairs is
 * known at build, so every token is pre-signed then (scripts/
 * gen-attribution.mjs) and shipped as data. Neither the stdio server on a
 * user's machine nor the hosted endpoint ever holds the private key. The
 * date in the token is therefore the token's ISSUE date (when that pair was
 * first signed, re-stamped when the pair's target URL changes), not a click
 * timestamp — stated honestly here and in the docs.
 */

/** The recommendation surfaces a token can bind. Mirrors utm_medium. */
export const ATTRIBUTION_SURFACES = ["agent", "console", "scan", "landscape", "report"] as const;
export type AttributionSurface = (typeof ATTRIBUTION_SURFACES)[number];

export const GVT_VERSION = "gvt1";

/** Pinned Graviti Ed25519 public key (SPKI, base64) — byte-identical to the
 *  published /public-key.pem and to the pin in the open mirror's verifiers.
 *  Public by definition; embedding it here lets server-side surfaces verify
 *  inbound tokens with zero fetches. */
export const GRAVITI_PUBLIC_KEY_B64 = "MCowBQYDK2VwAyEAPYznSNiELA8x6Eym7rk50GExv63QJeupB9uQQCOh7Ck=";

export const GRAVITI_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----\n${GRAVITI_PUBLIC_KEY_B64}\n-----END PUBLIC KEY-----\n`;

/** Per-brand attribution record, as shipped in data/attribution-tokens.json
 *  and in the `attribution` block of each public category file. */
export interface BrandAttribution {
  /** The brand's own site/product URL attribution applies to (never a
   *  provenance receipt — those stay byte-exact). */
  url: string;
  /** UTC date the tokens for this pair were issued (signed into each token). */
  issued: string;
  /** Signed token per surface. */
  gvt: Record<AttributionSurface, string>;
}

export const ATTRIBUTION_NOTE =
  "Outbound recommendation links carry deterministic UTM parameters (utm_source=graviti, " +
  "utm_medium=<surface: agent|console|scan|landscape|report>, utm_campaign=<category slug>, " +
  "utm_content=<brand slug>) plus a signed gvt token, so the brand can verify in its own analytics " +
  "that the traffic came from a Graviti recommendation. The token binds (surface, category, brand, " +
  "issue date) and is Ed25519-signed with the same published key that signs the integrity ledger " +
  "(/public-key.pem) — verifiable by anyone, spec at docs/ATTRIBUTION.md in the public engine mirror. " +
  "It identifies the recommendation surface, never the user: no user identifiers, no per-click values, " +
  "no session data — the same token is served to every visitor of the same surface. Attribution never " +
  "touches provenance receipts (claim provenance_url stays byte-exact) and never influences ranking.";

/** The signed message for a token: everything before the signature segment. */
export function gvtPayload(
  surface: AttributionSurface,
  category: string,
  brand: string,
  issuedYyyymmdd: string
): string {
  return `${GVT_VERSION}.${surface}.${category}.${brand}.${issuedYyyymmdd}`;
}

export interface ParsedGvt {
  version: string;
  surface: string;
  category: string;
  brand: string;
  /** YYYYMMDD as signed. */
  issued: string;
  /** base64url, no padding. */
  signature: string;
  /** The exact signed message (token minus the signature segment). */
  payload: string;
}

/** Structural parse only — signature verification needs a crypto runtime
 *  (node:crypto in src/tools.ts, openssl/node for brands per the docs). */
export function parseGvt(token: string): ParsedGvt | null {
  const parts = token.split(".");
  if (parts.length !== 6) return null;
  const [version, surface, category, brand, issued, signature] = parts;
  if (version !== GVT_VERSION) return null;
  if (!/^\d{8}$/.test(issued)) return null;
  if (!/^[A-Za-z0-9_-]{20,}$/.test(signature)) return null;
  if (!surface || !category || !brand) return null;
  return { version, surface, category, brand, issued, signature, payload: parts.slice(0, 5).join(".") };
}

/**
 * Construct an attributed outbound URL: the brand's own link plus the
 * canonical UTM set and (when a pre-signed token exists) the gvt token.
 * Existing query parameters on the brand's URL are preserved; the five
 * attribution parameters are set deterministically. Returns the raw URL
 * unchanged if it does not parse — attribution must never break a link.
 */
export function attributedUrl(
  rawUrl: string,
  surface: AttributionSurface,
  category: string,
  brand: string,
  token?: string
): string {
  try {
    const u = new URL(rawUrl);
    u.searchParams.set("utm_source", "graviti");
    u.searchParams.set("utm_medium", surface);
    u.searchParams.set("utm_campaign", category);
    u.searchParams.set("utm_content", brand);
    if (token) u.searchParams.set("gvt", token);
    else u.searchParams.delete("gvt");
    return u.toString();
  } catch {
    return rawUrl;
  }
}

/** Convenience over a BrandAttribution record. */
export function attributedUrlFor(
  rec: BrandAttribution | undefined,
  surface: AttributionSurface,
  category: string,
  brand: string
): string | null {
  if (!rec) return null;
  return attributedUrl(rec.url, surface, category, brand, rec.gvt[surface]);
}
