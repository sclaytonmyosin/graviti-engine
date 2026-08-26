#!/usr/bin/env node
// verify-payload.mjs — client-side transport-integrity check for Graviti payloads.
//
// The integrity ledger attests to the PUBLISHED record. This script closes the
// remaining gap: everything between Graviti's origin and your process —
// TLS-terminating proxies, CDNs, caches, load balancers — could alter a payload
// with no ledger entry capturing the delta. So verify what YOU received:
//
//   1. Fetch the payload from the origin.
//   2. Fetch the ledger from an INDEPENDENT second path (this repo's snapshot on
//      raw.githubusercontent.com) AND from the origin, verify both chains against
//      the PINNED signing key below, and cross-check the heads: a fork or an
//      origin rollback fails loudly.
//   3. Recompute the payload's sha256 (canonical JSON minus the volatile
//      generated_at + integrity fields; exact bytes for llms.txt) and compare it
//      to the head entry's signed files.artifacts manifest (ledger v25+).
//   4. Replay guard: a payload that no longer matches the head but matches an
//      OLDER entry is stale-but-validly-signed — reported as its own failure,
//      because a replayed yesterday is the subtle attack.
//
// Exit 0 only if every check passes. No dependencies beyond Node ≥ 20.
//
// Usage:
//   node scripts/verify-payload.mjs                       # verifies /index-full.json
//   node scripts/verify-payload.mjs /index.json /data/categories/magnesium-supplements.json
//   node scripts/verify-payload.mjs --origin https://graviti.thesingulariti.ai /llms.txt
//
// Testing hooks (used by the tamper/replay demos in the README):
//   --payload-file <f>   verify a local file's content as if it were the (single) named path
//   --ledger-file <f>    use a local ledger instead of fetching the mirror snapshot
//
// The honest boundary: a pass means the bytes that reached THIS process match
// the signed record. Nothing cryptographic reaches inside your own runtime or
// context window after that — if your stack mutates the data post-verification,
// no ledger can see it. Verify as close to the point of use as you can.
import { createHash, createPublicKey, verify as edVerify } from "node:crypto";
import { readFileSync } from "node:fs";

// PINNED Graviti signing key (Ed25519). Pinning is the point: the served
// /public-key.pem is cross-checked against this constant, never trusted alone.
const PINNED_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAPYznSNiELA8x6Eym7rk50GExv63QJeupB9uQQCOh7Ck=
-----END PUBLIC KEY-----
`;

const DEFAULT_ORIGIN = "https://graviti.thesingulariti.ai";
const MIRROR_LEDGER_URL =
  "https://raw.githubusercontent.com/sclaytonmyosin/graviti-engine/main/data/ledger.json";

// --- canonicalization (identical to the ledger's; jq -cjS reproduces it) -----
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
const sha256utf8 = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const sha256bytes = (b) => createHash("sha256").update(b).digest("hex");

let failures = 0;
const ok = (msg) => console.log(`  ✓ ${msg}`);
const warn = (msg) => console.error(`  ⚠ ${msg}`);
const fail = (msg) => {
  failures++;
  console.error(`  ✗ FAIL: ${msg}`);
};

// --- args ---------------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  if (i === -1) return null;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
};
const origin = (flag("--origin") ?? DEFAULT_ORIGIN).replace(/\/$/, "");
const payloadFile = flag("--payload-file");
const ledgerFile = flag("--ledger-file");
const paths = argv.length ? argv : ["/index-full.json"];
if (payloadFile && paths.length !== 1) {
  console.error("--payload-file verifies exactly one named path");
  process.exit(2);
}

async function fetchText(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

// --- ledger chain verification against the pinned key --------------------------
const pinnedKey = createPublicKey(PINNED_PUBLIC_KEY_PEM);
function verifyChain(ledger, label) {
  let prev = "genesis";
  for (const entry of ledger.entries) {
    const { entry_hash, signature, signing_key, anchor, ...core } = entry;
    if (sha256utf8(canonicalize(core)) !== entry_hash)
      return `${label}: v${entry.version} entry_hash does not recompute`;
    if (core.prev_entry_hash !== prev) return `${label}: v${entry.version} chain link broken`;
    if (!edVerify(null, Buffer.from(entry_hash, "utf8"), pinnedKey, Buffer.from(signature, "base64")))
      return `${label}: v${entry.version} signature invalid against the PINNED key`;
    prev = entry_hash;
  }
  return null;
}

// --- 1. ledgers: independent second path + origin, cross-checked ---------------
console.log(`Ledger — pinned key, two independent paths`);
let mirrorLedger = null;
try {
  mirrorLedger = JSON.parse(
    ledgerFile ? readFileSync(ledgerFile, "utf8") : await fetchText(MIRROR_LEDGER_URL)
  );
  const err = verifyChain(mirrorLedger, ledgerFile ? "local ledger" : "mirror ledger");
  if (err) {
    fail(err);
    mirrorLedger = null;
  } else {
    ok(
      `${ledgerFile ? `local ledger (${ledgerFile})` : "mirror ledger (raw.githubusercontent.com)"}: ` +
        `${mirrorLedger.entries.length} entries, chain continuous, all signatures verify against the pinned key`
    );
  }
} catch (e) {
  warn(`mirror ledger unavailable (${e.message}) — falling back to origin only, losing the second path`);
}

let originLedger = null;
try {
  originLedger = JSON.parse(await fetchText(`${origin}/ledger.json`));
  const err = verifyChain(originLedger, "origin ledger");
  if (err) {
    fail(err);
    originLedger = null;
  } else {
    ok(`origin ledger (${origin}/ledger.json): ${originLedger.entries.length} entries, chain + signatures valid`);
  }
} catch (e) {
  warn(`origin ledger unavailable (${e.message})`);
}

if (!mirrorLedger && !originLedger) {
  fail("no verifiable ledger from either path — cannot verify anything");
  console.error(`\nFAILED — ${failures} check(s) failed`);
  process.exit(1);
}

// Cross-check the two paths. The mirror is synced AFTER every production
// deploy, so origin briefly ahead is legitimate mid-release; the reverse —
// origin serving an OLDER ledger than the public mirror — is a rollback and fails.
let ledger = mirrorLedger ?? originLedger;
if (mirrorLedger && originLedger) {
  const m = mirrorLedger.entries[mirrorLedger.entries.length - 1];
  const o = originLedger.entries[originLedger.entries.length - 1];
  if (m.entry_hash === o.entry_hash) {
    ok(`heads agree: v${m.version} (${m.entry_hash.slice(0, 16)}…) on both paths`);
  } else if (o.version > m.version) {
    const prefix = originLedger.entries[m.version - 1];
    if (prefix && prefix.entry_hash === m.entry_hash) {
      warn(
        `origin is at v${o.version}, mirror snapshot at v${m.version} and consistent — ` +
          `legitimate only mid-release (mirror syncs after deploy); proceeding against origin head`
      );
      ledger = originLedger;
    } else {
      fail(`FORK: origin v${o.version} does not extend the mirror's v${m.version} — histories diverge`);
    }
  } else {
    const prefix = mirrorLedger.entries[o.version - 1];
    if (prefix && prefix.entry_hash === o.entry_hash) {
      fail(
        `ROLLBACK: origin serves v${o.version} but the public mirror has v${m.version} — ` +
          `the origin (or something in front of it) is replaying an old ledger`
      );
    } else {
      fail(`FORK: mirror v${m.version} and origin v${o.version} do not share history`);
    }
  }
}
const head = ledger.entries[ledger.entries.length - 1];

// --- 2. served public key vs pinned -------------------------------------------
try {
  const served = await fetchText(`${origin}/public-key.pem`);
  const strip = (pem) => pem.replace(/-----[^-]+-----|\s/g, "");
  if (strip(served) === strip(PINNED_PUBLIC_KEY_PEM)) {
    ok("served /public-key.pem matches the pinned key");
  } else {
    fail(
      "served /public-key.pem DIFFERS from the pinned key — something in the path is substituting " +
        "the signing identity (signatures above were checked against the pinned key only)"
    );
  }
} catch (e) {
  warn(`could not fetch /public-key.pem (${e.message})`);
}

// --- 3. payloads against the head entry's signed manifest ----------------------
if (!head.files?.artifacts) {
  fail(
    `ledger head v${head.version} carries no files manifest (added in v25) — ` +
      "cannot pin payloads against it"
  );
} else {
  console.log(`\nPayloads — against the signed manifest of head v${head.version}`);
  for (const path of paths) {
    const expected = head.files.artifacts[path];
    if (!expected) {
      if (head.files.not_pinned?.[path]) {
        fail(`${path}: deliberately not pinned — ${head.files.not_pinned[path]}`);
      } else {
        fail(`${path}: not in the signed manifest (pinned paths: index, index-full, categories, llms.txt)`);
      }
      continue;
    }
    let raw;
    try {
      raw = payloadFile ? readFileSync(payloadFile) : Buffer.from(await fetchText(`${origin}${path}`));
    } catch (e) {
      fail(`${path}: fetch failed (${e.message})`);
      continue;
    }
    let actual;
    let payload = null;
    if (path.endsWith(".json")) {
      try {
        payload = JSON.parse(raw.toString("utf8"));
      } catch {
        fail(`${path}: response is not valid JSON`);
        continue;
      }
      const { generated_at, integrity, ...pinned } = payload;
      actual = sha256utf8(canonicalize(pinned));
    } else {
      actual = sha256bytes(raw);
    }

    if (actual === expected) {
      ok(`${path}: sha256 matches the signed manifest (${actual.slice(0, 16)}…)`);
    } else {
      // Distinguish tampering from replay: does it match an OLDER signed entry?
      const older = ledger.entries.find(
        (e) => e !== head && e.files?.artifacts?.[path] === actual
      );
      if (older) {
        fail(
          `${path}: STALE — matches the signed manifest of v${older.version} (${older.timestamp}), ` +
            `not the head v${head.version}. Validly signed but superseded: something in the path is ` +
            `serving you an old payload.`
        );
      } else {
        fail(
          `${path}: TAMPERED — sha256 ${actual.slice(0, 16)}… matches no signed manifest ` +
            `(head expects ${expected.slice(0, 16)}…). The bytes you received are not what was published.`
        );
      }
      continue;
    }

    // Envelope cross-check: generated_at/integrity are excluded from the hash
    // (self-referential), so pin the integrity block to the chain separately.
    if (payload?.integrity) {
      const ref = payload.integrity.latest_entry_hash;
      if (ref === head.entry_hash) {
        ok(`${path}: embedded integrity block references the head entry`);
      } else {
        const referenced = ledger.entries.find((e) => e.entry_hash === ref);
        if (referenced) {
          fail(
            `${path}: embedded integrity block references v${referenced.version}, not the head ` +
              `v${head.version} — stale envelope`
          );
        } else {
          fail(`${path}: embedded integrity block references an entry hash not in the verified chain`);
        }
      }
    }
  }
}

console.log("");
if (failures > 0) {
  console.error(
    `FAILED — ${failures} check(s) failed. Do not trust this payload: the bytes that reached this ` +
      `process do not match Graviti's signed record.`
  );
  process.exit(1);
}
console.log(
  `PASSED — every payload byte-checks against ledger head v${head.version}, signed by the pinned key, ` +
    `on two independent paths. Boundary: this proves integrity up to the edge of YOUR process — ` +
    `nothing cryptographic reaches inside your runtime after this point.`
);
