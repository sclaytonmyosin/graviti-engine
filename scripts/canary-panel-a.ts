/**
 * Panel A canaries — public subset, runnable by anyone.
 *
 *   npm run canary
 *
 * Graviti runs canary-based drift detection: subjects of known ground truth
 * are pushed through the system on every build (Panel A: engine, routing,
 * structural invariants, adversarial cases) and every audit-crawl cycle
 * (Panel B: steady/drifted/gone provenance pages the site controls). Panel A
 * fails the production build on any divergence; live status is published in
 * the `canaries` block of https://graviti.thesingulariti.ai/pulse.json.
 *
 * This file ports the Panel A cases that the sample index supports, over the
 * exact engine this repository publishes — so an outsider can run the same
 * canaries the build runs, with zero secrets. Assertions are structural
 * properties and relative invariants, never exact scores: exact-score pins
 * break on every legitimate data change.
 *
 * For the full design (two-panel independence rationale, the adversarial-case
 * reasons, incident history) see docs/CANARIES.md in the private repo — the
 * relevant text is mirrored in the README's canary section.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  matchIntent,
  detectCategory,
  claimDecay,
  STALE_MARKER,
  type Brand,
  type BrandIndex,
  type CategoryBlock,
} from "../src/engine.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const index: BrandIndex = JSON.parse(readFileSync(join(ROOT, "data", "sample-index.json"), "utf8"));

let total = 0;
let failed = 0;
function check(name: string, ok: boolean, detail?: string) {
  total++;
  if (!ok) {
    failed++;
    console.error(`[canary] FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const singleBlockIndex = (block: CategoryBlock): BrandIndex => ({ categories: [block], accountability_log: [] });

// --- 1. routing goldens (the sample's five categories) -----------------------
const ROUTING_GOLDENS: [string, string][] = [
  ["best magnesium supplement", "magnesium-supplements"],
  ["whats the cheapest magnesium that actually helps with sleep?", "magnesium-supplements"],
  ["best cold plunge with a chiller", "cold-plunge"],
  ["electrolyte drink for a marathon", "sports-hydration"],
  ["best organic face moisturizer", "natural-skincare"],
  ["best single origin coffee beans", "coffee"],
];
for (const [q, expected] of ROUTING_GOLDENS) {
  const r = matchIntent(index, q);
  check(
    `route: "${q}"`,
    r.in_index && r.category.id === expected,
    `expected ${expected}, got ${r.in_index ? r.category.id : "out-of-scope"}`
  );
}
{
  const r = matchIntent(index, "best mortgage refinance lender");
  check("route: out-of-scope refusal", r.in_index === false);
}

// --- 2. shadowing (behavioral, over the sample's keywords) -------------------
// Every category must win a query built from each of its own keywords, and
// keywords must be lowercase (the matcher lowercases the query only, so an
// uppercase keyword can never match — a dead keyword).
for (const block of index.categories) {
  for (const k of block.category.match_keywords) {
    check(`shadowing: keyword "${k}" is lowercase`, k === k.toLowerCase());
    const routed = detectCategory(index, `best ${k.toLowerCase()}`);
    check(
      `shadowing: "${k}" routes to its own category ${block.category.id}`,
      routed?.category.id === block.category.id,
      `routed to ${routed?.category.id ?? "out-of-scope"}`
    );
  }
}

// --- 3. structural invariants (full sweep — the NaN regression net) ----------
for (const block of index.categories) {
  const r = matchIntent(singleBlockIndex(block), `best ${block.category.match_keywords[0]}`);
  if (!r.in_index) {
    check(`sweep ${block.category.id}: routes on its own keyword`, false);
    continue;
  }
  const recs = r.recommendations;
  check(
    `sweep ${block.category.id}: every fit_score finite and in [0,1]`,
    recs.every((x) => Number.isFinite(x.fit_score) && x.fit_score >= 0 && x.fit_score <= 1),
    recs.filter((x) => !Number.isFinite(x.fit_score)).map((x) => x.brand_id).join(", ")
  );
  check(
    `sweep ${block.category.id}: catalog-tier brands never ranked`,
    recs.every((x) => x.evidence_state !== "catalog_only")
  );
  check(
    `sweep ${block.category.id}: demo exhibits (Auralite/Somnalux) never rank`,
    recs.every((x) => !["auralite-wellness", "somnalux"].includes(x.brand_id))
  );
  check(
    `sweep ${block.category.id}: revoked brands excluded`,
    recs.every((x) => x.verification_status !== "revoked")
  );
  check(`sweep ${block.category.id}: rank_influenced_by_payment false`, r.disclosure.rank_influenced_by_payment === false);
  check(
    `sweep ${block.category.id}: info_quality_influences_ranking false`,
    r.disclosure.info_quality_influences_ranking === false
  );
}

// Lifecycle penalty: a flagged brand scores strictly below its unflagged self.
{
  const block = index.categories.find((c) => c.category.id === "magnesium-supplements")!;
  const q = "best magnesium supplement";
  const base = matchIntent(singleBlockIndex(block), q);
  if (base.in_index) {
    const target = base.recommendations[0];
    const flaggedBlock = clone(block);
    const fb = flaggedBlock.brands.find((b) => b.id === target.brand_id)!;
    fb.verification.status = "flagged";
    fb.verification.flag = {
      opened: "2026-08-01T00:00:00Z",
      issue: "synthetic canary flag",
      remediation_deadline: "2026-11-01T00:00:00Z",
      gap_summary: "canary fixture",
    };
    const flagged = matchIntent(singleBlockIndex(flaggedBlock), q);
    const after = flagged.in_index ? flagged.recommendations.find((x) => x.brand_id === target.brand_id) : undefined;
    check(
      "lifecycle: flagged brand scores below its unflagged self",
      !!after && after.fit_score < target.fit_score,
      `unflagged ${target.fit_score} vs flagged ${after?.fit_score}`
    );
  }
}

// Claim decay: a synthetic backdated claim is marked stale and carries
// degraded weight (in-memory fixture only).
{
  const staleDate = new Date(Date.now() - 400 * 86_400_000).toISOString();
  const mkBrand = (id: string, lastChecked: string): Brand => ({
    id,
    name: id,
    product: "Canary fixture",
    fictional: true,
    verified_paid: false,
    data_tier: "captured",
    verification: { status: "unverified", last_audit: null, note: "canary fixture" },
    claims: [
      {
        claim: "Ships free over $50 with a launch discount price of $9.99",
        provenance_url: "https://example-canary.com/page",
        first_verified: null,
        last_checked: lastChecked,
        corroboration_count: 1,
      },
    ],
    attributes: { price_tier: "mid", known_for: "canary fixture" },
  });
  check("decay: a 400-day-old fast-class claim is stale", claimDecay(mkBrand("x", staleDate).claims[0]).stale === true);
  const block: CategoryBlock = {
    category: { id: "canary-fixture-category", name: "Canary fixture", match_keywords: ["canaryfixture"], attributes_glossary: {} },
    brands: [mkBrand("fresh-canary", new Date().toISOString()), mkBrand("stale-canary", staleDate)],
  };
  const r = matchIntent(singleBlockIndex(block), "best canaryfixture");
  if (r.in_index) {
    const fresh = r.recommendations.find((x) => x.brand_id === "fresh-canary");
    const stale = r.recommendations.find((x) => x.brand_id === "stale-canary");
    check(
      "decay: stale claim shows the stale marker on the payload",
      !!stale && stale.top_claims.some((c) => c.stale === true && c.stale_note?.includes(STALE_MARKER))
    );
    check(
      "decay: stale claim carries degraded weight",
      !!fresh && !!stale && stale.fit_score < fresh.fit_score,
      `fresh ${fresh?.fit_score} vs stale ${stale?.fit_score}`
    );
  }
}

// --- 4. adversarial — the popular answer must NOT win ------------------------
// WHY: "best coffee" invites the majority prior — Starbucks, Dunkin, Nespresso,
// and Keurig are household giants sitting at catalog tier (zero captured
// claims). If fame ever leaks into ranking, it leaks here first: they must
// stay in the labeled landscape while smaller evidenced brands rank.
{
  const r = matchIntent(index, "best coffee");
  const giants = ["starbucks", "dunkin", "nespresso", "keurig"];
  if (r.in_index) {
    check(
      "adversarial: catalog-tier giants never rank in coffee",
      r.recommendations.every((x) => !giants.includes(x.brand_id))
    );
    check(
      "adversarial: catalog-tier giants appear labeled, not hidden",
      giants.every((g) => r.in_landscape_not_evidenced.some((x) => x.brand_id === g))
    );
    check("adversarial: evidenced coffee brands still rank", r.recommendations.length > 0);
  } else {
    check("adversarial: 'best coffee' routes", false);
  }
}

// WHY: Solgar is the most recognizable name in magnesium and carries zero
// captured claims — the biggest brand stays unranked while smaller evidenced
// brands rank on their record.
{
  const r = matchIntent(index, "best magnesium");
  if (r.in_index) {
    check("adversarial: Solgar (famous, catalog-tier) never ranks", r.recommendations.every((x) => x.brand_id !== "solgar"));
    check(
      "adversarial: Solgar appears labeled in the landscape",
      r.in_landscape_not_evidenced.some((x) => x.brand_id === "solgar")
    );
  }
}

// WHY: the known magnesium case — the first law, running. An unverified brand
// must outrank the paying, verified one on the sleep-price question; if a
// verified brand tops it while fitting worse, payment has leaked into scoring.
{
  const r = matchIntent(index, "whats the cheapest magnesium that actually helps with sleep?");
  if (r.in_index) {
    const top = r.recommendations[0];
    check(
      "adversarial: unverified-beats-verified holds on the known magnesium case",
      !!top && top.verification_status !== "verified" && r.recommendations.some((x) => x.verification_status === "verified"),
      `top: ${top?.brand_id} (${top?.verification_status})`
    );
  }
}

// --- verdict ------------------------------------------------------------------
if (failed > 0) {
  console.error(`[canary] PANEL A (public subset) FAILED — ${failed}/${total} cases diverged.`);
  process.exit(1);
}
console.log(`[canary] PANEL A (public subset) PASS — ${total} cases over the sample index.`);
console.log("Same idea in production: every build runs the full panel and fails closed; live status in the canaries block of https://graviti.thesingulariti.ai/pulse.json");
