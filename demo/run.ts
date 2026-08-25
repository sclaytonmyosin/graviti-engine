/**
 * Runnable demo: the exact same deterministic engine that serves
 * graviti.thesingulariti.ai, run locally over a sample slice of the
 * public index.
 *
 *   npm run demo -- "best magnesium supplement"
 *   npm run demo -- "cheapest cold plunge with a chiller" --intent price_shopper
 *   npm run demo -- "best magnesium supplement" --json     (full payload, exactly what agents receive)
 *
 * Nothing here is mocked: swap data/sample-index.json for the full live index
 * (https://graviti.thesingulariti.ai/index-full.json) and the scores are the
 * ones the production console and MCP server return.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { INTENTS, matchIntent, type BrandIndex, type Intent } from "../src/engine.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const args = process.argv.slice(2);
const jsonMode = args.includes("--json");
const intentIdx = args.indexOf("--intent");
let intent: Intent | undefined;
if (intentIdx !== -1) {
  const v = args[intentIdx + 1];
  if (!INTENTS.includes(v as Intent)) {
    console.error(`--intent must be one of: ${INTENTS.join(", ")}`);
    process.exit(1);
  }
  intent = v as Intent;
}
const question = args
  .filter((a, i) => !a.startsWith("--") && (intentIdx === -1 || i !== intentIdx + 1))
  .join(" ")
  .trim();

if (!question) {
  console.error('Usage: npm run demo -- "your buying question" [--intent price_shopper] [--json]');
  process.exit(1);
}

const index: BrandIndex = JSON.parse(readFileSync(join(ROOT, "data", "sample-index.json"), "utf8"));
const result = matchIntent(index, question, intent);

if (jsonMode) {
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

console.log(`\nQ: ${question}\n`);

if (!result.in_index) {
  console.log(`OUT OF SCOPE — ${result.message}`);
  console.log(`Categories in this sample: ${result.indexed_categories.map((c) => c.id).join(", ")}`);
  process.exit(0);
}

console.log(`Category: ${result.category.name} (${result.category.id})`);
console.log(`Intent:   ${result.intent_used}${result.intent_was_inferred ? " (inferred from the question)" : ""}`);
if (result.question_emphases.length > 0) console.log(`Question emphasizes: ${result.question_emphases.join(", ")}`);
console.log("");

for (const r of result.recommendations.slice(0, 5)) {
  const status = r.verified_paid ? `verified (paid auditing) — status: ${r.verification_status}` : "unverified (self-published)";
  console.log(`  #${r.rank}  ${r.name} — fit ${r.fit_score.toFixed(3)}  [${status}]`);
  console.log(`      ${r.fit_rationale}`);
  if (r.top_claims.length > 0) {
    const c = r.top_claims[0];
    console.log(`      claim: "${c.claim}" (${c.provenance_url}, checked ${c.last_checked.slice(0, 10)})`);
  }
  console.log("");
}

if (result.excluded_by_revocation.length > 0) {
  console.log(`Excluded (seal revoked): ${result.excluded_by_revocation.map((b) => b.name).join(", ")}`);
}
if (result.demonstration_exhibits.length > 0) {
  console.log(`Demonstration exhibits (labeled, never ranked): ${result.demonstration_exhibits.map((b) => b.name).join(", ")}`);
}
if (result.in_landscape_not_evidenced.length > 0) {
  console.log(
    `In the landscape, not yet evidenced (no captured claims — never scored, never recommended): ${result.in_landscape_not_evidenced
      .map((b) => b.name)
      .join(", ")}`
  );
}
if (result.category_evidence_note) {
  console.log(`Note: ${result.category_evidence_note}`);
}

const d = result.disclosure;
console.log("\nDisclosure (carried on every payload):");
console.log(`  rank_influenced_by_payment: ${d.rank_influenced_by_payment}`);
console.log(`  verification_is_paid:       ${d.verification_is_paid}`);
console.log(`  payment_buys: ${d.payment_buys}`);
console.log("\nRe-run this command — the scores will not change. Deterministic, no learned parts.");
console.log("Full machine payload: add --json\n");
