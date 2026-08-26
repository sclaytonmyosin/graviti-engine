// Public ledger verification — needs NO secrets. Anyone (including keyless CI)
// can prove the published ledger is internally consistent:
//   1. every entry_hash recomputes from the entry's core fields
//   2. every prev_entry_hash links to the previous entry (back to "genesis")
//   3. every signature verifies against the PUBLISHED public key
//   4. the LIVE public index (https://graviti.thesingulariti.ai/index-full.json)
//      canonical hash is reported against the latest entry (informational: the
//      index may legitimately run ahead of the ledger between signed releases)
// Exits non-zero on any chain/signature failure.
//
// By default this verifies the ledger snapshot committed in data/ledger.json.
// Pass --live to fetch the current ledger from the public endpoint instead:
//   node scripts/verify-ledger.mjs --live
import { createHash, verify, createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LIVE = "https://graviti.thesingulariti.ai";

function canonicalize(value) {
  if (Array.isArray(value)) return "[" + value.map(canonicalize).join(",") + "]";
  if (value !== null && typeof value === "object") {
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + canonicalize(value[k]))
        .join(",") +
      "}"
    );
  }
  return JSON.stringify(value);
}
const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");

const useLive = process.argv.includes("--live");
const ledger = useLive
  ? await (await fetch(`${LIVE}/ledger.json`)).json()
  : JSON.parse(readFileSync(join(ROOT, "data/ledger.json"), "utf8"));
console.log(`[verify-ledger] verifying ${useLive ? `${LIVE}/ledger.json (live)` : "data/ledger.json (committed snapshot)"}`);
const pubKey = createPublicKey(readFileSync(join(ROOT, "data/public-key.pem")));

let prev = "genesis";
let failures = 0;
for (const entry of ledger.entries) {
  const { entry_hash, signature, signing_key, anchor, ...core } = entry;
  const problems = [];
  if (sha256(canonicalize(core)) !== entry_hash) problems.push("entry_hash does not recompute");
  if (core.prev_entry_hash !== prev) problems.push("prev_entry_hash does not link");
  if (!verify(null, Buffer.from(entry_hash, "utf8"), pubKey, Buffer.from(signature, "base64")))
    problems.push("signature invalid against published public key");
  if (problems.length) {
    failures++;
    console.error(`[verify-ledger] v${entry.version} FAIL: ${problems.join("; ")}`);
  } else {
    console.log(`[verify-ledger] v${entry.version} ok — hash recomputes, chain links, signature valid (anchor: ${anchor?.status ?? "none"})`);
  }
  prev = entry_hash;
}

// Rubric pin (v26+): the entry core — hashed and signature-verified above —
// includes the scoring-engine source hashes, so the chain check already covers
// them. Additionally cross-check the pinned hash against THIS repo's engine
// copy: src/engine.ts here is the verbatim production module, so the two must
// match whenever this mirror is in sync (independently: `git hash-object
// src/engine.ts` must equal rubric.engine_git_blob_sha1).
const head = ledger.entries[ledger.entries.length - 1];
if (head?.rubric) {
  const engineSha = createHash("sha256")
    .update(readFileSync(join(ROOT, head.rubric.engine)))
    .digest("hex");
  if (engineSha === head.rubric.engine_sha256) {
    console.log(
      `[verify-ledger] head v${head.version} pins the scoring rubric — this repo's ${head.rubric.engine} matches ` +
        `(sha256 ${engineSha.slice(0, 16)}…; independently: git hash-object ${head.rubric.engine} → ` +
        `${head.rubric.engine_git_blob_sha1})`
    );
  } else {
    console.log(
      `[verify-ledger] note: this repo's ${head.rubric.engine} does not match the rubric pinned at ` +
        `v${head.version} — mirror engine out of sync with the signed release (re-sync pending, or ` +
        `you are verifying a live ledger newer than this checkout)`
    );
  }
}

// Reproduce the index hash from the LIVE full index (the ledger hashes the
// full index content — the sample slice in this repo is a subset by design).
try {
  const full = await (await fetch(`${LIVE}/index-full.json`)).json();
  const indexHash = sha256(canonicalize({ accountability_log: full.accountability_log, categories: full.categories }));
  const last = ledger.entries[ledger.entries.length - 1];
  if (last?.index_sha256 === indexHash) {
    console.log(`[verify-ledger] live index-full.json matches latest entry v${last.version}`);
  } else {
    console.log(
      `[verify-ledger] note: live index does not match latest entry v${last?.version ?? "none"} — either the index is ahead of the ledger (a signed release will append the next entry) or this committed ledger snapshot is behind the live one (re-run with --live)`
    );
  }
} catch {
  console.log("[verify-ledger] note: could not fetch the live index (offline?) — chain and signatures verified above are unaffected");
}

if (failures > 0) {
  console.error(`[verify-ledger] FAILED — ${failures} broken entr${failures === 1 ? "y" : "ies"}`);
  process.exit(1);
}
console.log(`[verify-ledger] PASSED — ${ledger.entries.length} entries, chain continuous, all signatures valid`);
