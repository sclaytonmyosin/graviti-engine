/**
 * Graviti scoring engine — the single source of truth for ranking and disclosure.
 *
 * Pure functions over a brand index. No I/O. Imported by both the MCP server
 * (src/server.ts → dist/server.js) and the web console (web/). One engine,
 * not a fork: if scoring changes, it changes for every surface at once.
 *
 * Three laws live here:
 *   1. Verification status carries zero weight in ranking. Lifecycle penalties
 *      (flagged/degraded) come from monitored quality signals, never from
 *      payment status — and they are disclosed, deterministic, and public.
 *   2. Payment buys speed, never outcome: a brand can pay to fast-track a
 *      re-evaluation, but payment can never change what it finds or skip it.
 *   3. Graviti never answers outside its verified index. Unmatched questions
 *      return an explicit out-of-scope result, not a guess.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Claim {
  claim: string;
  provenance_url: string;
  first_verified: string | null;
  last_checked: string;
  corroboration_count: number;
  /** The brand-confirmation loop: when continuous auditing finds drift or a
   *  claim it can't re-verify, the brand is asked to confirm. Until resolved
   *  the claim is publicly marked awaiting confirmation — visible, honest,
   *  non-punitive (no lifecycle penalty; the ask itself is the record). */
  confirmation_status?: "awaiting_brand_confirmation";
  confirmation_requested?: string;
  confirmation_reason?: string;
  /** "authenticated_endorsement": a creator relationship where Graviti verified
   *  the paid relationship is disclosed AND the creator verifiably uses the
   *  product. FTC-compliant by construction. */
  claim_type?: "authenticated_endorsement";
  creator?: string;
  relationship_disclosed?: boolean;
  usage_verified?: boolean;
  /** The creator holds the Graviti Certified Creator mark: matched to the brand
   *  by the same fit engine, relationships verified-disclosed, usage verified. */
  certified_creator?: boolean;
}

/** The seal lifecycle. Verification is not a one-time stamp — it can be lost. */
export type VerificationStatus =
  | "verified"
  | "flagged"
  | "degraded"
  | "revoked"
  | "under_review"
  | "unverified";

export const LIFECYCLE_STATES: Record<VerificationStatus, string> = {
  verified: "Claims audited, provenance checked, freshness monitored. Continuous — not a one-time stamp.",
  flagged:
    "Continuous monitoring found an issue (return rates, complaint patterns, formulation drift, claim staleness). " +
    "Still verified, publicly annotated. The brand holds a gap report and a remediation window (default 90 days).",
  degraded:
    "Remediation window expired with issues unresolved. The seal stands but the fit score carries a real, " +
    "disclosed penalty until re-evaluation passes.",
  revoked:
    "Seal pulled. The brand is excluded from recommendations and appears only in the public accountability log. " +
    "A pulled seal is the loudest proof the seal means something.",
  under_review:
    "Re-evaluation in progress. A brand can pay to fast-track the queue (review starts within 2 business days " +
    "instead of the guaranteed 14 calendar days) — the review itself is identical in both lanes, and payment " +
    "never touches the verdict.",
  unverified: "Never enrolled. Self-published claims, never independently audited. Ranked on equal footing.",
};

/** Deterministic, disclosed score penalty per lifecycle state. Revoked brands
 *  never reach scoring — they are excluded from recommendations entirely. */
export const LIFECYCLE_PENALTY: Record<VerificationStatus, number> = {
  verified: 0,
  flagged: 0.05,
  degraded: 0.15,
  revoked: 0,
  under_review: 0,
  unverified: 0,
};

export interface VerificationFlag {
  opened: string;
  issue: string;
  remediation_deadline: string;
  gap_summary: string;
}

// ---------------------------------------------------------------------------
// Evidence states — the gate on scoring. Distinct from verification (payment)
// and from data_tier (capture pipeline stage): a brand with zero captured
// claims has no evidence to score, so it gets no fit score and is never
// recommended — it appears in landscapes as present, labeled, unranked.
// ---------------------------------------------------------------------------

/** Evidence sufficiency — the gate on scoring. Distinct from verification
 *  (payment) and from data_tier (capture pipeline stage). */
export type EvidenceState = "audited" | "sourced" | "catalog_only";

export function evidenceState(b: Brand): EvidenceState {
  if (b.verification.status === "verified") return "audited";
  if (b.claims.length > 0) return "sourced";
  return "catalog_only";
}

export const EVIDENCE_STATES: Record<EvidenceState, string> = {
  audited: "Claims captured with sources AND independently audited on a continuous cycle (the paid seal).",
  sourced: "Claims captured verbatim from the brand's own public pages, each with a source URL — never independently audited.",
  catalog_only:
    "Listed in the category with public-knowledge attributes only — no captured claims. " +
    "Insufficient evidence for a fit score or a recommendation: shown in landscapes as present, never ranked.",
};

export const INSUFFICIENT_EVIDENCE_NOTE =
  "In the landscape, not yet evidenced: this brand is indexed for category completeness, but Graviti has " +
  "not captured any sourced claims for it, so it receives no fit score and is never returned as a " +
  "recommendation. Claim capture (free of rank consequence, like everything else) is what changes this.";

// ---------------------------------------------------------------------------
// Specifications — the ingredient/spec disclosure layer. Records what a brand
// DISCLOSES about composition (an auditable, self-published fact), never
// whether the product works (an efficacy judgment Graviti structurally refuses).
// ---------------------------------------------------------------------------

/** The structural honesty fence. Present on every specifications payload. */
export const SPEC_NOT_ASSESSED = ["efficacy", "clinical_outcomes"];

export interface SpecIngredient {
  name: string;
  inci?: string | null;
  compound_form?: string | null;
  active?: boolean | null;
  role?: string | null;
  concentration_stated?: string | null;
  provenance_url?: string | null;
  last_checked?: string | null;
}

export interface Specifications {
  not_assessed: string[];
  form: string | null;
  net_size: string | null;
  serving: string | null;
  price_stated_usd?: number | null;
  source: {
    provenance_url: string;
    http_status: number | null;
    url_verified?: boolean;
    fetch_method: string;
    last_checked: string | null;
  };
  ingredients?: SpecIngredient[];
  components?: { name: string; ingredients: SpecIngredient[] }[];
  other_ingredients?: string;
  ingredient_list_complete: boolean;
  nomenclature: "inci_full_declaration" | "inci" | "compound_forms" | "common_names" | "partial" | "none";
  concentrations_disclosed: "per_active" | "total_only" | "none";
  quantities_stated?: Record<string, unknown>;
  testing_docs: { status: string; detail: string; provenance_url?: string | null };
  /** Whether a net size or a quantified serving spec is stated on the source page. */
  size_or_serving_stated: boolean;
  disclosure_gaps: string[];
  marketing_claims_observed_not_captured?: string[];
}

/** Visible label carried by the two retained demonstration exhibits — surfaced
 *  on every payload where a demo entry appears. */
export const DEMO_NOTE =
  "Demonstration entry — not a real brand. Retained to illustrate the seal lifecycle " +
  "(verified → flagged → degraded → revoked); excluded from all rankings and recommendations.";

export interface Brand {
  id: string;
  name: string;
  product: string;
  fictional: boolean;
  /** Fictional demonstration exhibit kept to illustrate the seal lifecycle.
   *  Never ranked, never recommended — appears only clearly labeled. */
  demo?: boolean;
  demo_note?: string;
  verified_paid: boolean;
  /** Data-capture tier for expansion entries. "captured": claims machine-captured
   *  verbatim from the brand's public pages. "catalog": brand verified live,
   *  category placement + public-knowledge attributes only, claims pending
   *  capture. Absent on the original hand-curated entries. Capture is not
   *  verification — every tier ranks on equal footing. */
  data_tier?: "captured" | "catalog";
  claims_note?: string;
  website?: string;
  verification: {
    status: VerificationStatus;
    last_audit: string | null;
    note: string;
    flag?: VerificationFlag;
  };
  claims: Claim[];
  attributes: Record<string, number | boolean | string | string[]>;
  /** Optional ingredient/spec disclosure layer. Absent = not yet assessed
   *  (never scored as zero — scoring absent data would defame brands we
   *  haven't gotten to). */
  specifications?: Specifications;
}

export interface AccountabilityEntry {
  date: string;
  brand_id: string;
  brand_name: string;
  category_id: string;
  from_status: VerificationStatus | null;
  to_status: VerificationStatus;
  reason: string;
  /** Confirmation-loop events: a claim-level ask or its resolution. No
   *  lifecycle change, no penalty — logged so the loop is publicly auditable.
   *  "retired": a fictional demonstration brand removed from the index.
   *  "demonstration_retained": a fictional exhibit kept, labeled, non-ranking.
   *  "claim_removed": a claim struck from a brand's record (e.g. provenance
   *  that cannot be cited), with the reason public.
   *  "gap_report_delivered": a paid-tier gap report was prepared and delivered
   *  to the brand — logged with payment status so the engagement itself is
   *  publicly auditable. Findings and rank are never affected.
   *
   *  Roster events (selection transparency — who is in the index, who is not,
   *  and why, on the public record; see docs/SELECTION.md):
   *  "brand_added": a brand entered the index, with the lane/source of the
   *  addition. Inclusion implies no relationship and buys nothing.
   *  "brand_removed": a real brand removed from the index, reason public
   *  (distinct from "retired", which covers fictional demonstration entries).
   *  "brand_declined": a brand asked to be indexed and was not, reason public.
   *  "brand_skipped": a brand was deliberately not indexed during category
   *  coverage, reason public — the honest record of editorial omission. */
  event?:
    | "confirmation_request"
    | "confirmation_resolved"
    | "retired"
    | "demonstration_retained"
    | "claim_removed"
    | "gap_report_delivered"
    | "brand_added"
    | "brand_removed"
    | "brand_declined"
    | "brand_skipped";
  /** Roster events: the expansion lane or editorial source of the change
   *  (e.g. "streaming expansion lane", "inbound brand request"). */
  lane?: string;
  source?: string;
  /** Entry concerns a labeled demonstration exhibit, not a real brand. */
  demo?: boolean;
}

/** Plain-language line for a claim awaiting brand confirmation. */
export function confirmationNote(claim: Claim, brandName: string): string | null {
  if (claim.confirmation_status !== "awaiting_brand_confirmation") return null;
  const since = claim.confirmation_requested ? claim.confirmation_requested.slice(0, 10) : "recently";
  return `Graviti has asked ${brandName} to confirm this — awaiting response since ${since}.${claim.confirmation_reason ? ` Why: ${claim.confirmation_reason}` : ""}`;
}

// ---------------------------------------------------------------------------
// Claim decay classes — per-claim-type freshness policy, disclosed and enforced.
// A price changes on a promo calendar; a certification changes on an audit
// calendar. One freshness bar for both would be either paranoid or blind, so
// every claim gets a decay class with a disclosed re-verification window.
// A claim past its window is STALE: it degrades VISIBLY (marked on every
// payload, reduced scoring weight) — never silently, and never to zero.
// Stale is not false; scoring absent data would defame, same convention as
// the neutral 0.5 for unknown attributes and the not-a-zero rule for absent
// specifications.
// ---------------------------------------------------------------------------

export type DecayClass = "fast" | "medium" | "slow" | "static";

/** The public decay-class table. Windows are calibrated to how often each kind
 *  of fact actually changes in the wild, not to what flatters the index. */
export const CLAIM_DECAY_CLASSES: Record<DecayClass, { window_days: number | null; covers: string }> = {
  fast: {
    window_days: 45,
    covers: "prices, promotional terms, discounts, free-shipping thresholds, plan lineups",
  },
  medium: {
    window_days: 120,
    covers:
      "guarantees, warranties, shipping and return policies, product formulations — plus any claim " +
      "no rule matches (the default: general marketing statements change on page-redesign timescales)",
  },
  slow: {
    window_days: 365,
    covers: "certifications, third-party testing documentation, facility/origin claims",
  },
  static: {
    window_days: null,
    covers: "founding facts, ownership, identity — facts that do not expire",
  },
};

/** Ordered classification rules over the claim text — first match wins, and
 *  the FASTEST class is checked first, so a claim mixing a promo price with a
 *  founding date decays at the fastest applicable rate (the most volatile
 *  component governs). Public and auditable: this table IS the policy. */
export const CLAIM_DECAY_RULES: { decay_class: DecayClass; pattern: RegExp }[] = [
  {
    decay_class: "fast",
    pattern:
      /\$\s?\d|price|pricing|% off|discount|promo|\bdeals?\b|\bsale\b|free ship|subscri|autopay|\/mo\b|per month|\bplans?\b/i,
  },
  {
    decay_class: "medium",
    pattern:
      /guarantee|warrant|refund|return|money.?back|risk.?free|shipping|deliver|formulat|ingredient|recipe/i,
  },
  {
    decay_class: "slow",
    pattern:
      /certif|third.?part|lab.?test|tested|\bcoa\b|usda|\bgmp\b|iso \d|b corp|leaping bunny|climate neutral|facilit|made in|manufactur|sourc|origin|organic/i,
  },
  {
    decay_class: "static",
    pattern: /found(ed|er)|family.?owned|since \d{4}|established|started by|owned by|headquarter/i,
  },
];

export function decayClassOf(claim: Claim): DecayClass {
  for (const rule of CLAIM_DECAY_RULES) {
    if (rule.pattern.test(claim.claim)) return rule.decay_class;
  }
  return "medium";
}

export interface ClaimDecay {
  decay_class: DecayClass;
  window_days: number | null;
  days_since_check: number;
  stale: boolean;
  stale_note?: string;
}

export const STALE_MARKER = "stale — pending re-verification";

/** Freshness verdict for one claim: its class, its window, and whether the
 *  last successful re-verification is past that window. */
export function claimDecay(claim: Claim, now: number = Date.now()): ClaimDecay {
  const decay_class = decayClassOf(claim);
  const { window_days } = CLAIM_DECAY_CLASSES[decay_class];
  const days_since_check = Math.max(
    0,
    Math.floor((now - new Date(claim.last_checked).getTime()) / 86_400_000)
  );
  const stale = window_days !== null && days_since_check > window_days;
  return {
    decay_class,
    window_days,
    days_since_check,
    stale,
    ...(stale
      ? {
          stale_note:
            `${STALE_MARKER}: last re-verified ${days_since_check} days ago, past the disclosed ` +
            `${window_days}-day ${decay_class}-class window. Stale is not false — the claim stays ` +
            `on record at reduced scoring weight until re-verification.`,
        }
      : {}),
  };
}

export const CLAIM_DECAY_POLICY =
  "Per-claim freshness policy, disclosed and enforced: every claim carries a decay class assigned by a " +
  "public rule table in the open engine source (CLAIM_DECAY_RULES — first match wins, fastest class " +
  "checked first, unmatched claims default to medium). Windows: fast 45d (prices, promotions, plan " +
  "lineups), medium 120d (guarantees, policies, formulations, and the default), slow 365d " +
  "(certifications, testing documentation, facility/origin), static (founding facts, ownership, " +
  "identity — no expiry). A claim past its window is marked '" + STALE_MARKER + "' on every payload " +
  "and counts at half weight where captured-claim depth feeds scoring, so a fully stale record " +
  "degrades toward the neutral 0.5 used for unknowns — visibly, never silently, and never to zero: " +
  "stale is not false, and scoring absent data would defame. Re-verification (the continuous audit " +
  "crawl, prioritized by proximity to each claim's window) restores full weight.";

export interface CategoryMeta {
  id: string;
  name: string;
  match_keywords: string[];
  attributes_glossary: Record<string, string>;
  /** Regulatory or scope note for the category (e.g. CBD/peptides/hair-loss
   *  capture restrictions). Carried into public payloads. */
  category_note?: string;
  /** Category-level sensitivity fence (e.g. efficacy, spiritual/wellbeing
   *  outcomes for the contemplative-learning categories). Carried into
   *  public payloads and rendered on the category surface. */
  not_assessed?: string[];
}

export interface CategoryBlock {
  category: CategoryMeta;
  brands: Brand[];
}

export interface BrandIndex {
  categories: CategoryBlock[];
  accountability_log: AccountabilityEntry[];
}

export const INTENTS = ["anxious_first_timer", "technical_buyer", "price_shopper", "general"] as const;
export type Intent = (typeof INTENTS)[number];

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

// ---------------------------------------------------------------------------
// info_quality — deterministic 0–100 disclosure-completeness score.
// Measures how completely a brand DISCLOSES composition — transparency, never
// product quality. A perfectly transparent mediocre product outscores a
// secretive great one, and that is the point. Structurally quarantined from
// ranking: it is never an input to the fit score (disclosure carries
// info_quality_influences_ranking: false on every payload).
// ---------------------------------------------------------------------------

export const INFO_QUALITY_NOTE =
  "info_quality measures transparency and completeness of disclosure (0–100), never product quality, " +
  "and carries zero weight in ranking. Absent = not yet assessed, which is not a zero. " +
  "Graviti does not assess: " + SPEC_NOT_ASSESSED.join(", ") + ".";

export interface InfoQuality {
  score: number;
  breakdown: Record<string, number>;
  max: Record<string, number>;
  reasons: Record<string, string>;
  influences_ranking: false;
  note: string;
  not_assessed: string[];
}

const NOMENCLATURE_POINTS: Record<string, number> = {
  inci_full_declaration: 15,
  inci: 15,
  compound_forms: 15,
  common_names: 7,
  partial: 7,
  none: 0,
};

const QUANTIFICATION_POINTS: Record<string, number> = {
  per_active: 20,
  total_only: 10,
  none: 0,
};

const TESTING_DOCS_POINTS: Record<string, number> = {
  published_third_party: 15,
  facility_cert: 5,
  claimed_no_doc: 5,
  none: 0,
  none_on_page: 0,
  withdrawn: 0,
};

export function infoQuality(spec: Specifications, now: number = Date.now()): InfoQuality {
  const hasList = (spec.ingredients?.length ?? 0) > 0 || (spec.components?.length ?? 0) > 0;
  const ingredient_disclosure = hasList ? (spec.ingredient_list_complete ? 30 : 15) : 0;
  const nomenclature_precision = NOMENCLATURE_POINTS[spec.nomenclature] ?? 0;
  const quantification = QUANTIFICATION_POINTS[spec.concentrations_disclosed] ?? 0;
  const form_size_serving = spec.form ? (spec.size_or_serving_stated ? 10 : 5) : 0;
  const testing_docs = TESTING_DOCS_POINTS[spec.testing_docs.status] ?? 0;

  let provenance_freshness = 0;
  let freshnessReason = "Source page not live-verifiable — no freshness credit.";
  if (spec.source.url_verified !== false && spec.source.last_checked) {
    const ageDays = (now - new Date(spec.source.last_checked).getTime()) / 86_400_000;
    if (ageDays <= 30) {
      provenance_freshness = 10;
      freshnessReason = "Every spec fact live-verified within the last 30 days.";
    } else if (ageDays <= 90) {
      provenance_freshness = 5;
      freshnessReason = "Spec facts last live-verified within 90 days.";
    } else {
      freshnessReason = "Spec facts last verified more than 90 days ago.";
    }
  }

  const breakdown = {
    ingredient_disclosure,
    nomenclature_precision,
    quantification,
    form_size_serving,
    testing_docs,
    provenance_freshness,
  };

  return {
    score: Object.values(breakdown).reduce((a, b) => a + b, 0),
    breakdown,
    max: {
      ingredient_disclosure: 30,
      nomenclature_precision: 15,
      quantification: 20,
      form_size_serving: 10,
      testing_docs: 15,
      provenance_freshness: 10,
    },
    reasons: {
      ingredient_disclosure: hasList
        ? spec.ingredient_list_complete
          ? "Full ingredient list published on the brand's own page."
          : "Partial ingredient list only (composition not fully disclosed)."
        : "No ingredient list published.",
      nomenclature_precision:
        nomenclature_precision === 15
          ? "Standardized names (INCI / exact compound forms) published."
          : nomenclature_precision === 7
            ? "Common or partial names only — no standardized nomenclature."
            : "No usable ingredient nomenclature.",
      quantification:
        quantification === 20
          ? "Amount or concentration stated for every active."
          : quantification === 10
            ? "Totals only — no per-active breakdown."
            : "No amounts or concentrations stated.",
      form_size_serving: spec.form
        ? spec.size_or_serving_stated
          ? "Form and net size / serving spec stated."
          : "Form stated, but no net size or quantified serving spec on the page."
        : "Form not stated.",
      testing_docs:
        testing_docs === 15
          ? "Independently verifiable testing document or certification published."
          : testing_docs === 5
            ? "Testing claimed (or facility-level cert) but no verifiable document linked."
            : spec.testing_docs.status === "withdrawn"
              ? "Testing claim withdrawn after audit inquiry — scores zero by rule."
              : "No testing documentation.",
      provenance_freshness: freshnessReason,
    },
    influences_ranking: false,
    note: INFO_QUALITY_NOTE,
    not_assessed: spec.not_assessed,
  };
}

// ---------------------------------------------------------------------------
// Disclosure — structural, on every payload
// ---------------------------------------------------------------------------

export const RANKING_METHOD =
  "Deterministic fit-score over disclosed category attributes. Weights come from the stated or inferred " +
  "buyer intent plus attribute emphases extracted from the question text itself. Lifecycle penalties from " +
  "monitored quality signals (flagged −0.05, degraded −0.15, revoked excluded) are fixed, disclosed, and " +
  "published to the accountability log. Scoring code is public and open for audit " +
  "(https://github.com/sclaytonmyosin/graviti-engine). Payment carries zero weight. Conversion data is " +
  "never an input: the engine is pure functions over the public index, and any ranking is reproducible " +
  "from public data alone. Every claim carries a disclosed decay class (fast 45d / medium 120d / slow " +
  "365d / static); a claim past its window is marked 'stale — pending re-verification' on every payload " +
  "and counts at half weight where claim depth feeds scoring — degraded visibly, never silently, and " +
  "never to zero: stale is not false.";

export const PAYMENT_BUYS =
  "Verification depth and re-evaluation queue position — never outcomes, never rank. A brand that fixes " +
  "its issues can pay to fast-track re-evaluation: payment compresses only the wait for review (to within " +
  "2 business days), never the review itself. The free lane is guaranteed entry into review within 14 days, " +
  "so the paid advantage is bounded. Every flag or degradation stays on the record with its penalty for a " +
  "minimum of 7 days regardless of payment.";

export const OUT_OF_SCOPE_MESSAGE =
  "This category isn't in Graviti's verified index yet. Graviti only answers from audited, provenance-backed " +
  "claims — it never guesses.";

/** The seal is never a bare badge: every surface that renders a verification
 *  status carries this scope block and a dereference to the signed ledger
 *  entry the status resolves to. Honest limits, stated structurally. */
export const SEAL_SCOPE = {
  what_this_verifies:
    "Record integrity (the entry is hash-chained, Ed25519-signed, and Bitcoin-anchored — history cannot be " +
    "quietly rewritten), claim provenance (every claim cites the public source URL it was captured from), " +
    "and freshness (claims are continuously re-crawled on disclosed decay windows; stale is marked visibly).",
  what_this_does_not_verify:
    "That the brand's claims were true when the brand wrote them, product quality, safety, efficacy, or " +
    "outcomes. Capture is not endorsement; a coherent claim held at a stable URL passes every provenance " +
    "check. The seal attests to the record and the process, never to the product.",
  dereference:
    "Every seal resolves to a signed ledger entry: the head entry of " +
    "https://graviti.thesingulariti.ai/ledger.json pins (by sha256) the exact payloads this status was " +
    "served in. Verify the chain, the signature, and the Bitcoin anchor per the instructions on /ledger.",
} as const;

export function disclosure(brands: Brand[], inIndex = true) {
  return {
    in_index: inIndex,
    verification_is_paid: true,
    rank_influenced_by_payment: false,
    payment_buys: PAYMENT_BUYS,
    ranking_method: RANKING_METHOD,
    verified_paid_entries: brands.filter((b) => b.verified_paid).map((b) => b.id),
    unverified_entries: brands.filter((b) => !b.verified_paid).map((b) => b.id),
    lifecycle_annotations: brands
      .filter((b) => ["flagged", "degraded", "revoked", "under_review"].includes(b.verification.status))
      .map((b) => ({ brand_id: b.id, status: b.verification.status })),
    ...(brands.some((b) => b.demo)
      ? {
          demonstration_entries: brands
            .filter((b) => b.demo)
            .map((b) => ({ brand_id: b.id, note: b.demo_note ?? DEMO_NOTE })),
        }
      : {}),
    data_tiers: {
      captured: brands.filter((b) => b.data_tier === "captured").length,
      catalog: brands.filter((b) => b.data_tier === "catalog").length,
      note:
        "captured: claims machine-captured verbatim from the brand's own public pages (still unverified). " +
        "catalog: brand verified live, attributes only, claims pending capture. Within scoreable tiers, " +
        "tier never affects rank weighting; catalog entries are not scored at all.",
    },
    evidence_states: {
      audited: brands.filter((b) => evidenceState(b) === "audited").length,
      sourced: brands.filter((b) => evidenceState(b) === "sourced").length,
      catalog_only: brands.filter((b) => evidenceState(b) === "catalog_only").length,
      policy:
        "Brands without captured claims (catalog_only) are never scored and never returned as " +
        "recommendations; they appear in landscapes labeled 'in the landscape, not yet evidenced'. " +
        "Within scoreable states, evidence tier carries zero rank weight.",
    },
    claim_decay: {
      classes: Object.fromEntries(
        Object.entries(CLAIM_DECAY_CLASSES).map(([k, v]) => [
          k,
          `${v.window_days === null ? "no expiry" : `${v.window_days}-day window`} — ${v.covers}`,
        ])
      ),
      policy: CLAIM_DECAY_POLICY,
    },
    seal_scope: SEAL_SCOPE,
    info_quality_influences_ranking: false,
    specifications_policy:
      "Some entries carry a specifications block (ingredient/spec disclosure) with an info_quality score: " +
      "a deterministic 0–100 measure of how completely the brand discloses composition — transparency, " +
      "never product quality — surfaced as its own dimension and never folded into fit ranking. " +
      "Entries without the block are not yet assessed (not a zero). Graviti does not assess: " +
      SPEC_NOT_ASSESSED.join(", ") + ".",
    policy:
      "Brands pay for verification (claim auditing, provenance checks, freshness) and may pay to " +
      "fast-track re-evaluation — never for rank, never for outcomes. The seal can be lost: flags, " +
      "degradations, and revocations are published to the public accountability log. Ranking is " +
      "algorithmic and auditable. Questions outside the verified index get an explicit refusal, never a guess.",
  };
}

// ---------------------------------------------------------------------------
// Category detection — keyword matching, deterministic and auditable
// ---------------------------------------------------------------------------

export function detectCategory(index: BrandIndex, question: string): CategoryBlock | null {
  const q = question.toLowerCase();
  let best: CategoryBlock | null = null;
  let bestScore = 0;
  for (const block of index.categories) {
    // Multi-word keywords are more specific and outweigh generic single words:
    // "energy drink" (2) must beat sports-hydration's "drink" (1).
    let score = 0;
    for (const k of block.category.match_keywords) {
      if (q.includes(k)) score += k.trim().split(/\s+/).length;
    }
    if (score > bestScore) {
      best = block;
      bestScore = score;
    }
  }
  return bestScore > 0 ? best : null;
}

// ---------------------------------------------------------------------------
// Signals — normalized 0..1 facts per brand, defined per category.
// Every mapping is a disclosed, fixed function of the category attributes.
// ---------------------------------------------------------------------------

const TUB_MATERIAL_SCORE: Record<string, number> = {
  stainless_steel: 1,
  composite: 0.7,
  rotomolded: 0.5,
  inflatable: 0.15,
};

const SIGNAL_EXTRACTORS: Record<string, (b: Brand) => Record<string, number>> = {
  "magnesium-supplements": (b) => {
    const a = b.attributes as Record<string, number & boolean>;
    return {
      value: clamp01(1 - Number(a.price_per_serving_usd) / 1.5),
      tested: a.third_party_tested ? 1 : 0,
      gentle: a.gentle_on_stomach ? 1 : 0,
      absorption: a.chelated ? 1 : 0,
      breadth: clamp01(Number(a.forms_count) / 7),
      guarantee: clamp01(Number(a.money_back_days) / 365),
    };
  },
  "cold-plunge": (b) => {
    const a = b.attributes as Record<string, number & boolean & string>;
    return {
      value: clamp01(1 - Number(a.price_usd) / 8000),
      made_usa: a.made_in_usa ? 1 : 0,
      convenience: a.has_chiller ? 1 : 0,
      warranty: clamp01(Number(a.warranty_years) / 5),
      certified: a.third_party_electrical_cert ? 1 : 0,
      build: TUB_MATERIAL_SCORE[String(a.tub_material)] ?? 0.4,
    };
  },
  "sports-hydration": (b) => {
    const a = b.attributes as Record<string, number & boolean>;
    return {
      value: clamp01(1 - Number(a.price_per_serving_usd) / 2),
      low_sugar: clamp01(1 - Number(a.sugar_g) / 35),
      electrolytes: clamp01((Number(a.sodium_mg) + Number(a.potassium_mg)) / 900),
    };
  },
  "laundry-detergent": (b) => {
    const a = b.attributes as Record<string, number & boolean>;
    return {
      value: clamp01(1 - Number(a.price_per_load_usd) / 0.3),
      cold_water: a.cold_water_rated ? 1 : 0,
      scent_free: a.scent_free_variant ? 1 : 0,
      concentrated: a.concentrated ? 1 : 0,
      scent: a.scent_system ? 1 : 0,
    };
  },
  "natural-skincare": (b) => {
    const a = b.attributes as Record<string, number & boolean>;
    // Strict === true: expansion-lane entries carry "not captured" strings in
    // boolean slots, and a truthy string must not score as a captured yes.
    return {
      value: clamp01(1 - Number(a.price_usd) / 80),
      certified: a.certified_organic === true ? 1 : 0,
      concentrated: a.waterless_formula === true ? 1 : 0,
      scent_free: a.fragrance_free_option === true ? 1 : 0,
      guarantee: clamp01(Number(a.money_back_days) / 365),
    };
  },
};

// Generic extractor for expansion categories (no hand-built signal map).
// Deterministic and disclosed like the rest: price tier → value, advertised
// third-party testing → tested, captured-claim depth → evidence.
const PRICE_TIER_SCORE: Record<string, number> = {
  budget: 1,
  mid: 0.65,
  premium: 0.35,
  luxury: 0.15,
};

function genericSignals(b: Brand): Record<string, number> {
  const a = b.attributes;
  // Claim-decay enforcement where claim depth feeds scoring: a stale claim
  // counts at half weight, so a fully stale 3-claim record scores the neutral
  // 0.5 — degraded visibly toward "unknown", never zeroed (stale is not false).
  const evidenceDepth = b.claims.reduce((sum, c) => sum + (claimDecay(c).stale ? 0.5 : 1), 0);
  return {
    value: PRICE_TIER_SCORE[String(a.price_tier)] ?? 0.5,
    tested: a.coa_advertised === true || a.third_party_tested === true ? 1 : 0,
    evidence: clamp01(evidenceDepth / 3),
  };
}

export function signalsFor(categoryId: string): (b: Brand) => Record<string, number> {
  const extractor = SIGNAL_EXTRACTORS[categoryId] ?? genericSignals;
  // Finite guard: hand-built extractors assume the category's original numeric
  // schema, but expansion-lane entries may lack those fields (Number(undefined)
  // is NaN, and NaN poisons the whole fit score). An uncaptured attribute is
  // unknown, not bad — it scores a disclosed neutral 0.5, same convention as
  // the generic extractor's unknown price tier.
  return (b: Brand) =>
    Object.fromEntries(
      Object.entries(extractor(b)).map(([k, v]) => [k, Number.isFinite(v) ? v : 0.5])
    );
}

/** Descriptive text a brand carries; used for a small disclosed relevance bump
 *  when the question's own words name what the brand is known for. */
function descriptiveText(b: Brand): string {
  const a = b.attributes;
  return [b.name, b.product, a.known_for, a.positioning, a.hero_product, a.segment, a.product_form]
    .filter((v) => typeof v === "string")
    .join(" ")
    .toLowerCase();
}

// ---------------------------------------------------------------------------
// Question analysis — the question text pulls real weight.
// Each matched pattern boosts named signals and is echoed in the rationale.
// ---------------------------------------------------------------------------

interface QuestionSignal {
  pattern: RegExp;
  signals: string[];
  note: string;
}

const QUESTION_SIGNALS: QuestionSignal[] = [
  { pattern: /cheap|lowest price|price|budget|afford|cost|deal|inexpensive/, signals: ["value"], note: "lowest price" },
  { pattern: /made in (the )?(usa|america|us|united states)|american[- ]made|domestic/, signals: ["made_usa"], note: "made in America" },
  { pattern: /quality|build|built|durab|sturdy|premium|long[- ]last/, signals: ["build", "warranty", "certified"], note: "build quality" },
  { pattern: /\bsafe|certif|ul[- ]listed|etl|electrical/, signals: ["certified", "tested"], note: "safety & certification" },
  { pattern: /test|lab|coa|evidence|proof|studies|clinical/, signals: ["tested", "certified"], note: "independent testing" },
  { pattern: /absor|chelat|bioavail|glycinate|form/, signals: ["absorption", "breadth"], note: "absorption" },
  { pattern: /guarantee|refund|return polic|warranty/, signals: ["guarantee", "warranty"], note: "guarantee terms" },
  { pattern: /gentle|stomach|side effect|nausea/, signals: ["gentle"], note: "tolerability" },
  { pattern: /quiet|convenien|easy|maintenance|chiller|no ice|plug/, signals: ["convenience"], note: "convenience" },
  { pattern: /sugar[- ]free|zero sugar|no sugar|low[- ]sugar|less sugar|diabet/, signals: ["low_sugar"], note: "low/no sugar" },
  { pattern: /electrolyte|sodium|potassium|rehydrat|hydration|sweat|marathon|workout|cramp/, signals: ["electrolytes"], note: "electrolyte content" },
  { pattern: /cold[- ]?water|cold wash|wash(ing)? in cold/, signals: ["cold_water"], note: "cold-water performance" },
  {
    pattern: /sensitive skin|hypoallergenic|fragrance[- ]free|scent[- ]free|unscented|dye[- ]free|perfume[- ]free|eczema/,
    signals: ["scent_free"],
    note: "sensitive skin",
  },
  { pattern: /concentrat|compact|less plastic|waterless|anhydrous|no water/, signals: ["concentrated"], note: "concentrated formula" },
  { pattern: /\borganic\b|natrue|usda|cosmos[- ]certified/, signals: ["certified"], note: "organic certification" },
  { pattern: /(?<!un)scent(?![- ]?free)|smell|aroma/, signals: ["scent"], note: "scent" },
  { pattern: /verified|receipts|back(ed)? up|substantiat|on record|documented/, signals: ["evidence"], note: "documented claims" },
];

export function analyzeQuestion(question: string): { boosted: Set<string>; notes: string[] } {
  const q = question.toLowerCase();
  const boosted = new Set<string>();
  const notes: string[] = [];
  for (const qs of QUESTION_SIGNALS) {
    if (qs.pattern.test(q)) {
      qs.signals.forEach((s) => boosted.add(s));
      notes.push(qs.note);
    }
  }
  return { boosted, notes };
}

export function inferIntent(question: string): Intent {
  const q = question.toLowerCase();
  if (/cheap|price|budget|afford|cost|deal|lowest/.test(q)) return "price_shopper";
  if (/chelat|bioavail|absor|glycinate|citrate|form|elemental|clinical|study|dose|spec/.test(q))
    return "technical_buyer";
  if (/\bsafe|worri|first time|beginner|side effect|gentle|nervous|scared/.test(q))
    return "anxious_first_timer";
  return "general";
}

/** Signals each intent voice cares about (applied only where the category has them). */
const INTENT_EMPHASIS: Record<Intent, string[]> = {
  price_shopper: ["value"],
  technical_buyer: ["tested", "certified", "absorption", "breadth", "build", "electrolytes", "evidence"],
  anxious_first_timer: ["guarantee", "gentle", "certified", "tested", "warranty", "scent_free", "low_sugar"],
  general: [],
};

// Weight construction: every signal starts at BASE; intent emphasis adds
// INTENT_BOOST; a question match adds QUESTION_BOOST. Weights are then
// normalized so the fit score stays 0..1. Deterministic, no learned parts.
const BASE_WEIGHT = 0.5;
const INTENT_BOOST = 1.5;
const QUESTION_BOOST = 2.5;

function buildWeights(signalNames: string[], intent: Intent, boosted: Set<string>) {
  const weights: Record<string, number> = {};
  for (const name of signalNames) {
    let w = BASE_WEIGHT;
    if (INTENT_EMPHASIS[intent].includes(name)) w += INTENT_BOOST;
    if (boosted.has(name)) w += QUESTION_BOOST;
    weights[name] = w;
  }
  const total = Object.values(weights).reduce((a, b) => a + b, 0);
  for (const k of Object.keys(weights)) weights[k] /= total;
  return weights;
}

// ---------------------------------------------------------------------------
// Rationale facts — human-readable, per category
// ---------------------------------------------------------------------------

const FACTS: Record<string, (b: Brand) => string[]> = {
  "magnesium-supplements": (b) => {
    const a = b.attributes as Record<string, number & boolean>;
    const parts: string[] = [];
    if (a.third_party_tested) parts.push("third-party tested");
    if (a.chelated) parts.push("chelated");
    if (Number(a.money_back_days) >= 90) parts.push(`${a.money_back_days}-day guarantee`);
    parts.push(`$${Number(a.price_per_serving_usd).toFixed(2)}/serving`);
    return parts;
  },
  "cold-plunge": (b) => {
    const a = b.attributes as Record<string, number & boolean>;
    const parts: string[] = [`$${Number(a.price_usd).toLocaleString()}`];
    if (a.made_in_usa) parts.push("made in USA");
    parts.push(a.has_chiller ? "integrated chiller" : "manual fill");
    parts.push(`${a.warranty_years}-yr warranty`);
    if (a.third_party_electrical_cert) parts.push("third-party electrical cert");
    return parts;
  },
  "sports-hydration": (b) => {
    const a = b.attributes as Record<string, number & boolean & string>;
    const parts: string[] = [
      `${a.sugar_g}g sugar`,
      `${Number(a.sodium_mg) + Number(a.potassium_mg)}mg electrolytes (${a.serving_basis})`,
      `$${Number(a.price_per_serving_usd).toFixed(2)}/serving`,
    ];
    if (a.sugar_free_variant) parts.push("zero-sugar variant");
    return parts;
  },
  "laundry-detergent": (b) => {
    const a = b.attributes as Record<string, number & boolean>;
    const parts: string[] = [`$${Number(a.price_per_load_usd).toFixed(2)}/load`];
    if (a.cold_water_rated) parts.push("cold-water rated");
    if (a.scent_free_variant) parts.push("free & clear variant");
    if (a.concentrated) parts.push("concentrated");
    if (a.scent_system) parts.push("matching scent system");
    return parts;
  },
  "natural-skincare": (b) => {
    const a = b.attributes as Record<string, number & boolean & string>;
    const parts: string[] = [`$${a.price_usd}`, `made in ${a.country_of_origin}`];
    parts.push(a.certified_organic ? `${a.certification} certified` : "no certification stated");
    if (a.waterless_formula) parts.push("waterless formula");
    if (a.fragrance_free_option) parts.push("unscented option");
    if (Number(a.money_back_days) > 0) parts.push(`${a.money_back_days}-day money-back`);
    return parts;
  },
};

/** Generic facts for expansion categories: price tier, segment, what the brand
 *  is known for, and the state of its captured evidence. */
function genericFacts(b: Brand): string[] {
  const a = b.attributes;
  const parts: string[] = [];
  if (a.price_tier) parts.push(`${a.price_tier} price tier`);
  if (typeof a.segment === "string") parts.push(String(a.segment).replaceAll("_", " "));
  const knownFor = a.known_for ?? a.positioning ?? a.hero_product;
  if (typeof knownFor === "string") parts.push(`known for ${knownFor}`);
  if (a.coa_advertised === true) parts.push("advertises third-party COAs");
  if (b.data_tier !== "catalog" && b.claims.length > 0)
    parts.push(`${b.claims.length} claim${b.claims.length > 1 ? "s" : ""} on record`);
  return parts;
}

export function factsFor(categoryId: string): (b: Brand) => string[] {
  return FACTS[categoryId] ?? genericFacts;
}

// ---------------------------------------------------------------------------
// Payload builders — identical shapes across MCP server and web console
// ---------------------------------------------------------------------------

export function matchIntent(index: BrandIndex, question: string, intentProfile?: Intent) {
  const block = detectCategory(index, question);

  if (!block) {
    // The honest refusal. Graviti's identity: never pretend to know.
    return {
      question,
      in_index: false as const,
      message: OUT_OF_SCOPE_MESSAGE,
      indexed_categories: index.categories.map((c) => ({ id: c.category.id, name: c.category.name })),
      recommendations: [],
      disclosure: disclosure([], false),
    };
  }

  const intent = intentProfile ?? inferIntent(question);
  const { boosted, notes } = analyzeQuestion(question);
  const extractor = signalsFor(block.category.id);
  const facts = factsFor(block.category.id);
  const questionTokens = question.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 3);

  // Revoked brands never reach scoring — they live in the accountability log.
  // Demonstration exhibits never reach scoring either: they exist to show the
  // lifecycle, labeled, and are structurally barred from recommendations.
  // Catalog-only brands (zero captured claims) never reach scoring either:
  // a fit score needs evidence, and they have none on record yet.
  const demoExhibits = block.brands.filter((b) => b.demo);
  const nonDemo = block.brands.filter((b) => !b.demo);
  const excluded = nonDemo.filter((b) => b.verification.status === "revoked");
  const alive = nonDemo.filter((b) => b.verification.status !== "revoked");
  const scoreable = alive.filter((b) => evidenceState(b) !== "catalog_only");
  const inLandscapeOnly = alive.filter((b) => evidenceState(b) === "catalog_only");

  // Thin-category honesty guard: when few brands carry evidence, say so
  // instead of letting "#1 of 1" read like a market verdict.
  const category_evidence_note =
    scoreable.length === 0
      ? "No brand in this category has captured evidence yet — Graviti lists the landscape but makes no recommendation here."
      : scoreable.length < 3
        ? `Only ${scoreable.length} brand${scoreable.length === 1 ? "" : "s"} in this category ${scoreable.length === 1 ? "has" : "have"} captured evidence; the rest are listed unranked. Treat this ranking as a comparison among the evidenced few, not the whole market.`
        : null;

  const ranked = scoreable
    .map((b) => {
      const signals = extractor(b);
      const weights = buildWeights(Object.keys(signals), intent, boosted);
      let score = Object.entries(weights).reduce((sum, [k, w]) => sum + w * signals[k], 0);
      // Small relevance bump when the question names a supported use case.
      const useCases = (b.attributes.use_cases as string[] | undefined) ?? [];
      if (useCases.some((u) => question.toLowerCase().includes(u))) score += 0.05;
      // Disclosed relevance bump when the buyer's own words name what the
      // brand is known for (expansion categories carry descriptive attributes).
      const desc = descriptiveText(b);
      const nameHits = questionTokens.filter((t) => desc.includes(t)).length;
      score += Math.min(0.1, nameHits * 0.04);
      // Lifecycle penalty: fixed, disclosed, from monitored quality signals.
      const penalty = LIFECYCLE_PENALTY[b.verification.status];
      score = clamp01(score - penalty);
      return { brand: b, penalty, fit_score: Math.round(score * 1000) / 1000 };
    })
    .sort((x, y) => y.fit_score - x.fit_score);

  const emphasis = notes.length > 0 ? `; question emphasizes ${notes.join(", ")}` : "";

  return {
    question,
    in_index: true as const,
    category: {
      id: block.category.id,
      name: block.category.name,
      ...(block.category.category_note ? { category_note: block.category.category_note } : {}),
      ...(block.category.not_assessed ? { not_assessed: block.category.not_assessed } : {}),
    },
    intent_used: intent,
    intent_was_inferred: !intentProfile,
    question_emphases: notes,
    category_evidence_note,
    recommendations: ranked.map((r, i) => {
      const lifecycleNote =
        r.penalty > 0
          ? ` Carries a −${r.penalty.toFixed(2)} lifecycle penalty (${r.brand.verification.status}): ${r.brand.verification.flag?.issue ?? "see accountability log"}.`
          : "";
      const staleCount = r.brand.claims.filter((c) => claimDecay(c).stale).length;
      const staleNote =
        staleCount > 0
          ? ` ${staleCount > 1 ? `${staleCount} claims are past their decay windows` : "1 claim is past its decay window"} — ${STALE_MARKER} (reduced weight, never zero).`
          : "";
      return {
        rank: i + 1,
        brand_id: r.brand.id,
        name: r.brand.name,
        product: r.brand.product,
        fit_score: r.fit_score,
        fit_rationale: `Scored for ${intent.replaceAll("_", " ")}${emphasis} — ${facts(r.brand).join(", ")}.${lifecycleNote}${staleNote}`,
        verified_paid: r.brand.verified_paid,
        verification_status: r.brand.verification.status,
        evidence_state: evidenceState(r.brand),
        ...(r.brand.data_tier ? { data_tier: r.brand.data_tier } : {}),
        ...(r.brand.claims_note ? { claims_note: r.brand.claims_note } : {}),
        // Ingredient/spec disclosure — its own dimension, structurally
        // quarantined from the fit score above.
        ...(r.brand.specifications
          ? { specifications: r.brand.specifications, info_quality: infoQuality(r.brand.specifications) }
          : {}),
        flag: r.brand.verification.flag ?? null,
        // First two claims, plus any authenticated endorsements, any claims
        // awaiting brand confirmation, and any stale claims beyond them — all
        // are always surfaced: endorsements as a distinct claim type,
        // confirmation asks and stale markers because hiding either would
        // defeat the disclosure's honesty.
        top_claims: [
          ...r.brand.claims.slice(0, 2),
          ...r.brand.claims
            .slice(2)
            .filter(
              (c) =>
                c.claim_type === "authenticated_endorsement" ||
                c.confirmation_status === "awaiting_brand_confirmation" ||
                claimDecay(c).stale
            ),
        ].map((c) => {
          const decay = claimDecay(c);
          return {
            claim: c.claim,
            provenance_url: c.provenance_url,
            last_checked: c.last_checked,
            claim_type: c.claim_type,
            creator: c.creator,
            relationship_disclosed: c.relationship_disclosed,
            usage_verified: c.usage_verified,
            certified_creator: c.certified_creator,
            decay_class: decay.decay_class,
            decay_window_days: decay.window_days,
            ...(decay.stale ? { stale: true as const, stale_note: decay.stale_note } : {}),
            ...(c.confirmation_status
              ? {
                  confirmation_status: c.confirmation_status,
                  confirmation_requested: c.confirmation_requested,
                  confirmation_reason: c.confirmation_reason,
                  confirmation_note: confirmationNote(c, r.brand.name),
                }
              : {}),
          };
        }),
      };
    }),
    in_landscape_not_evidenced: inLandscapeOnly.map((b) => ({
      brand_id: b.id,
      name: b.name,
      product: b.product,
      evidence_state: "catalog_only" as const,
      note: INSUFFICIENT_EVIDENCE_NOTE,
    })),
    excluded_by_revocation: excluded.map((b) => ({
      brand_id: b.id,
      name: b.name,
      note: "Seal revoked — excluded from recommendations. History in the accountability log.",
    })),
    demonstration_exhibits: demoExhibits.map((b) => ({
      brand_id: b.id,
      name: b.name,
      verification_status: b.verification.status,
      note: b.demo_note ?? DEMO_NOTE,
    })),
    disclosure: disclosure(block.brands),
  };
}

// ---------------------------------------------------------------------------
// Accountability log — a pulled seal is the loudest proof the seal means something
// ---------------------------------------------------------------------------

export function accountabilityLog(index: BrandIndex) {
  const entries = [...index.accountability_log].sort((a, b) => b.date.localeCompare(a.date));
  return {
    lifecycle_states: LIFECYCLE_STATES,
    lifecycle_penalties: LIFECYCLE_PENALTY,
    entries,
    note:
      "Public, machine-readable log of every flag, degradation, revocation, and restoration. " +
      "Payment can fast-track a re-evaluation; it can never change what the re-evaluation finds. " +
      "Entries marked demo: true concern labeled demonstration exhibits — fictional brands retained " +
      "to illustrate this lifecycle, never ranked, never recommended. Roster changes are also logged " +
      "per brand (brand_added with lane/source, brand_removed, brand_declined, brand_skipped — each " +
      "with a public reason), so who is in the index, who is not, and why stays on the record.",
    disclosure: disclosure(index.categories.flatMap((c) => c.brands)),
  };
}

// ---------------------------------------------------------------------------
// Gap report — brand intelligence as a product. What stands between this brand
// and top-of-category, computed deterministically from the index. In production
// this also draws on consented, compensated cohort signals — never owned
// profiles: the profile stays in the user's agent.
// ---------------------------------------------------------------------------

const INTENT_COHORT_LABELS: Record<Intent, string> = {
  price_shopper: "price-shopper cohort",
  technical_buyer: "technical-buyer cohort",
  anxious_first_timer: "anxious first-timer cohort",
  general: "general buyers",
};

export function gapReport(index: BrandIndex, brand: string) {
  const needle = brand.toLowerCase();
  for (const block of index.categories) {
    const target = block.brands.find((b) => b.id === needle || b.name.toLowerCase().includes(needle));
    if (!target) continue;

    // Demonstration exhibits get no gap report — there is no market position
    // to close for a brand that does not exist.
    if (target.demo) {
      return {
        brand_id: target.id,
        name: target.name,
        category: { id: block.category.id, name: block.category.name },
        verification_status: target.verification.status,
        ...(target.verification.flag ? { open_flag: target.verification.flag } : {}),
        demo: true,
        demo_note: target.demo_note ?? DEMO_NOTE,
        disclosure: disclosure([target]),
      };
    }

    const extractor = signalsFor(block.category.id);
    // Ranks quoted to any brand are computed over evidenced brands only —
    // catalog-only entries are in the landscape, never in the comparison pool.
    const contenders = block.brands.filter(
      (b) => b.verification.status !== "revoked" && !b.demo && evidenceState(b) !== "catalog_only"
    );

    // A catalog-only target gets an honest insufficient-evidence report, not a
    // rank — a numeric position derived from zero captured claims would be
    // precision the evidence doesn't support.
    if (evidenceState(target) === "catalog_only") {
      return {
        brand_id: target.id,
        name: target.name,
        category: { id: block.category.id, name: block.category.name },
        verification_status: target.verification.status,
        evidence_state: "catalog_only" as const,
        insufficient_evidence: true,
        note: INSUFFICIENT_EVIDENCE_NOTE,
        in_landscape_with: contenders.slice(0, 8).map((b) => b.name),
        evidenced_competitors: contenders.length,
        what_capture_unlocks:
          "Claim capture records the facts you already publish, verbatim with source links. It makes you " +
          "scoreable and comparable — it never buys rank; nothing does.",
        disclosure: disclosure([target]),
      };
    }

    const signalsByBrand = new Map(contenders.map((b) => [b.id, extractor(b)]));
    const signalNames = Object.keys(signalsByBrand.get(contenders[0].id) ?? {});

    // Generic-intent benchmark: who leads the category, and on which signals.
    const genericWeights = buildWeights(signalNames, "general", new Set());
    const genericScore = (b: Brand) => {
      const s = signalsByBrand.get(b.id)!;
      const raw = Object.entries(genericWeights).reduce((sum, [k, w]) => sum + w * s[k], 0);
      return Math.max(0, raw - LIFECYCLE_PENALTY[b.verification.status]);
    };
    const genericRanked = [...contenders].sort((a, b) => genericScore(b) - genericScore(a));
    const leader = genericRanked[0];
    const targetSignals = signalsByBrand.get(target.id) ?? {};
    const leaderSignals = signalsByBrand.get(leader.id) ?? {};

    const attribute_gaps = signalNames
      .filter((k) => (leaderSignals[k] ?? 0) - (targetSignals[k] ?? 0) > 0.1)
      .map((k) => ({
        signal: k,
        yours: Math.round((targetSignals[k] ?? 0) * 100) / 100,
        category_leader: Math.round((leaderSignals[k] ?? 0) * 100) / 100,
        leader_name: leader.name,
      }));

    const generic_rank = {
      rank: genericRanked.findIndex((b) => b.id === target.id) + 1,
      of: contenders.length,
      of_note: "counted over brands with captured evidence; catalog-only brands are listed, not ranked",
      leader: leader.name,
    };

    // Per-cohort positions (all voices), plus the blind-spot subset (rank > 1).
    const cohort_positions = INTENTS.filter((i) => i !== "general").map((intent) => {
      const weights = buildWeights(signalNames, intent, new Set());
      const score = (b: Brand) => {
        const s = signalsByBrand.get(b.id)!;
        return Math.max(
          0,
          Object.entries(weights).reduce((sum, [k, w]) => sum + w * s[k], 0) -
            LIFECYCLE_PENALTY[b.verification.status]
        );
      };
      const order = [...contenders].sort((a, b) => score(b) - score(a));
      return {
        cohort: INTENT_COHORT_LABELS[intent],
        your_rank: order.findIndex((b) => b.id === target.id) + 1,
        of: contenders.length,
        cohort_leader: order[0].name,
      };
    });
    const cohort_blind_spots = cohort_positions.filter((c) => c.your_rank > 1);

    // Ingredient/spec disclosure dimension: the score's breakdown IS the report —
    // every lost point maps to a publishable fix. Improving it requires
    // publishing more truth, never paying Graviti.
    const FIX_SUGGESTIONS: Record<string, string> = {
      ingredient_disclosure: "publish the complete ingredient list on the product page",
      nomenclature_precision:
        "publish standardized names (INCI for topicals; exact compound forms for supplements)",
      quantification: "state the amount or concentration for every active ingredient",
      form_size_serving: "state the net size or a quantified serving spec on the page",
      testing_docs:
        "link an independently verifiable testing document (COA, or a registry-checkable certification)",
      provenance_freshness: "keep spec facts on a stable public page so continuous re-checks stay fresh",
    };
    let information_quality;
    if (target.specifications) {
      const iq = infoQuality(target.specifications);
      information_quality = {
        score: iq.score,
        breakdown: iq.breakdown,
        summary: `Your ingredient/spec disclosure is ${iq.score}/100. Publish the missing fields below to raise it — the score measures transparency, never product quality, and never affects rank.`,
        publishable_fixes: Object.entries(iq.breakdown)
          .filter(([k, v]) => v < iq.max[k])
          .map(([k, v]) => `+${iq.max[k] - v} available: ${FIX_SUGGESTIONS[k]} (currently: ${iq.reasons[k]})`),
        whats_not_published: target.specifications.disclosure_gaps,
        influences_ranking: false,
        not_assessed: target.specifications.not_assessed,
      };
    } else {
      information_quality = {
        status: "not_yet_assessed",
        note: "Ingredient/spec disclosure data has not been captured for this brand yet. Not a zero score.",
      };
    }

    return {
      brand_id: target.id,
      name: target.name,
      category: { id: block.category.id, name: block.category.name },
      verification_status: target.verification.status,
      ...(target.verification.flag ? { open_flag: target.verification.flag } : {}),
      category_leader: { brand_id: leader.id, name: leader.name },
      generic_rank,
      attribute_gaps,
      cohort_positions,
      cohort_blind_spots,
      claims_awaiting_confirmation: target.claims
        .filter((c) => c.confirmation_status === "awaiting_brand_confirmation")
        .map((c) => ({
          claim: c.claim,
          requested: c.confirmation_requested,
          reason: c.confirmation_reason,
          note: confirmationNote(c, target.name),
        })),
      information_quality,
      path_to_top:
        target.id === leader.id
          ? "This brand currently leads its category on the generic benchmark. Holding the seal means holding the signals."
          : `Close the ${attribute_gaps.map((g) => g.signal).join(", ") || "remaining"} gap(s) vs ${leader.name}` +
            (target.verification.flag ? `, and resolve the open flag before ${target.verification.flag.remediation_deadline.slice(0, 10)}` : "") +
            ". Re-evaluation can be fast-tracked for a fee — the fee compresses the queue wait (free lane guaranteed within 14 days), never the review or the finding.",
      product_note:
        "Demo of the paid brand-intelligence product: a research project that takes seconds, computed from the " +
        "index. In production it also draws on consented cohort signals — users opt in, get compensated, and " +
        "their profiles never leave their own agent. Graviti brokers the exchange; it never owns the profile.",
      disclosure: disclosure(block.brands),
    };
  }
  return {
    error: `No brand matching '${brand}' in index`,
    known_brands: index.categories.flatMap((c) => c.brands.map((b) => b.id)),
    disclosure: disclosure([], false),
  };
}

export function getVerifiedClaims(index: BrandIndex, brand: string) {
  const needle = brand.toLowerCase();
  for (const block of index.categories) {
    const hit = block.brands.find((b) => b.id === needle || b.name.toLowerCase().includes(needle));
    if (hit) {
      return {
        brand_id: hit.id,
        name: hit.name,
        product: hit.product,
        category: { id: block.category.id, name: block.category.name },
        ...(hit.demo ? { demo: true, demo_note: hit.demo_note ?? DEMO_NOTE } : {}),
        verified_paid: hit.verified_paid,
        verification: hit.verification,
        claims: hit.claims.map((c) => ({ ...c, decay: claimDecay(c) })),
        ...(hit.specifications
          ? { specifications: hit.specifications, info_quality: infoQuality(hit.specifications) }
          : { specifications_status: "not_yet_assessed — ingredient/spec disclosure data has not been captured for this brand; absence is not a zero score" }),
        disclosure: disclosure([hit]),
      };
    }
  }
  return {
    error: `No brand matching '${brand}' in index`,
    known_brands: index.categories.flatMap((c) => c.brands.map((b) => b.id)),
    disclosure: disclosure([], false),
  };
}

function categoryTable(block: CategoryBlock) {
  const anySpecs = block.brands.some((b) => b.specifications);
  const nonDemo = block.brands.filter((b) => !b.demo);
  return {
    category: block.category,
    ...(anySpecs ? { info_quality_note: INFO_QUALITY_NOTE } : {}),
    evidence_summary: {
      audited: nonDemo.filter((b) => evidenceState(b) === "audited").length,
      sourced: nonDemo.filter((b) => evidenceState(b) === "sourced").length,
      catalog_only: nonDemo.filter((b) => evidenceState(b) === "catalog_only").length,
      note: "catalog_only entries are in the landscape, not yet evidenced — listed for completeness, never ranked or recommended.",
    },
    table: block.brands.map((b) => ({
      brand_id: b.id,
      name: b.name,
      product: b.product,
      ...(b.demo ? { demo: true, demo_note: b.demo_note ?? DEMO_NOTE } : {}),
      verified_paid: b.verified_paid,
      verification_status: b.verification.status,
      evidence_state: evidenceState(b),
      ...(b.data_tier ? { data_tier: b.data_tier } : {}),
      ...(b.verification.flag ? { flag: b.verification.flag } : {}),
      last_audit: b.verification.last_audit,
      ...(b.specifications ? { info_quality: infoQuality(b.specifications).score } : {}),
      ...b.attributes,
    })),
  };
}

export function categoryLandscape(index: BrandIndex, category?: string) {
  if (category) {
    const block = index.categories.find((c) => c.category.id === category);
    if (!block) {
      return {
        error: `Category '${category}' not in the verified index`,
        available: index.categories.map((c) => c.category.id),
        disclosure: disclosure([], false),
      };
    }
    return { ...categoryTable(block), disclosure: disclosure(block.brands) };
  }
  return {
    categories: index.categories.map(categoryTable),
    disclosure: disclosure(index.categories.flatMap((c) => c.brands)),
  };
}
