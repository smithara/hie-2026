#!/usr/bin/env node
/**
 * zulip-users.mjs — build the poster → presenter Zulip account index.
 *
 * Reads the authoritative poster list (posters/expected.csv), fetches the
 * member list of the workshop Zulip via the bot in .zuliprc, matches each
 * presenter by name and writes posters/zulip-users.csv:
 *
 *   poster,author,zulip_user_id,zulip_name,match
 *
 *   match = auto    matched by name on this run (recomputed every run)
 *           manual  hand-corrected row — never touched by the script
 *           none    no confident match; fill in by hand and set match=manual
 *
 * The index is what lets a seed message @-mention the presenter of each
 * poster's discussion topic. This script only READS from Zulip; it never
 * posts anything.
 *
 * Run after posters/expected.csv changes or when new people join Zulip:
 *   npm run zulip-users
 * Needs: .zuliprc (gitignored) in the repo root, ~/.zuliprc, or $ZULIPRC.
 * No npm dependencies — Node ≥18 built-ins only.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXPECTED = path.join(ROOT, "posters", "expected.csv");
const INDEX = path.join(ROOT, "posters", "zulip-users.csv");

// ---------------------------------------------------------------------------
// .zuliprc  ([api] email= / key= / site=)
// ---------------------------------------------------------------------------
function loadZuliprc() {
  const candidates = [
    process.env.ZULIPRC,
    path.join(ROOT, ".zuliprc"),
    path.join(os.homedir(), ".zuliprc"),
  ].filter(Boolean);
  const file = candidates.find((f) => fs.existsSync(f));
  if (!file) {
    console.error(
      `\n✗ No .zuliprc found (looked in: ${candidates.join(", ")}).\n` +
        `  Download it from the bot's card under Zulip → Settings → Bots.\n`
    );
    process.exit(1);
  }
  const cfg = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*(email|key|site)\s*=\s*(.+?)\s*$/);
    if (m) cfg[m[1]] = m[2];
  }
  for (const k of ["email", "key", "site"]) {
    if (!cfg[k]) {
      console.error(`✗ ${path.relative(ROOT, file)} is missing "${k}="`);
      process.exit(1);
    }
  }
  cfg.site = cfg.site.replace(/\/+$/, "");
  return cfg;
}

async function zulipGet(cfg, endpoint, params = {}) {
  const url = new URL(`${cfg.site}/api/v1/${endpoint}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const auth = Buffer.from(`${cfg.email}:${cfg.key}`).toString("base64");
  const res = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.result !== "success") {
    throw new Error(`GET ${endpoint} → ${res.status} ${body.msg || res.statusText}`);
  }
  return body;
}

// ---------------------------------------------------------------------------
// CSV helpers (same minimal dialect as gen-posters.mjs)
// ---------------------------------------------------------------------------
function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') {
        inQ = false;
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQ = true;
    } else if (c === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function csvCell(s) {
  s = String(s ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function readCsvRows(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim() && !l.trim().startsWith("#"))
    .map(parseCsvLine);
}

// expected.csv: poster,topic,authors,title
function loadExpected() {
  const list = [];
  for (const [poster, , authors] of readCsvRows(EXPECTED)) {
    if (!poster || poster.toLowerCase() === "poster") continue;
    list.push({ poster: String(parseInt(poster, 10)), author: authors || "" });
  }
  return list;
}

// zulip-users.csv: poster,author,zulip_user_id,zulip_name,match
function loadIndex() {
  const map = new Map();
  for (const [poster, author, id, name, match] of readCsvRows(INDEX)) {
    if (!poster || poster.toLowerCase() === "poster") continue;
    map.set(String(parseInt(poster, 10)), { poster, author, id, name, match });
  }
  return map;
}

// ---------------------------------------------------------------------------
// Name matching. Both sides are reduced to a set of ASCII-folded tokens so
// "Eleanna Asvestari" ≡ "Asvestari Eleanna" ≡ "Eleanna  ASVESTARI". A match
// needs the presenter's surname token plus at least one more shared token
// (or all tokens when the name is a single word).
// ---------------------------------------------------------------------------
function tokens(name) {
  return (name || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z\s'-]/g, " ")
    .split(/[\s'-]+/)
    .filter((t) => t.length > 1); // drop initials / particles like "d"
}

function matchUser(author, users) {
  const want = tokens(author);
  if (want.length === 0) return { best: [], score: 0 };
  const surname = want[want.length - 1]; // expected.csv is "Firstname Lastname"
  let bestScore = 0;
  let best = [];
  for (const u of users) {
    const have = new Set(u.tokens);
    if (!have.has(surname)) continue;
    const shared = want.filter((t) => have.has(t)).length;
    if (shared < Math.min(2, want.length)) continue;
    // Prefer exact token-set matches, then most shared tokens.
    const exact = shared === want.length && u.tokens.length === want.length;
    const score = shared * 10 + (exact ? 5 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = [u];
    } else if (score === bestScore) {
      best.push(u);
    }
  }
  return { best, score: bestScore };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const cfg = loadZuliprc();
  const expected = loadExpected();
  if (expected.length === 0) {
    console.error(`✗ Nothing in ${path.relative(ROOT, EXPECTED)}`);
    process.exit(1);
  }

  console.log(`→ ${cfg.site} as ${cfg.email}`);
  const { members } = await zulipGet(cfg, "users");
  const users = members
    .filter((m) => m.is_active && !m.is_bot)
    .map((m) => ({ id: m.user_id, name: m.full_name, tokens: tokens(m.full_name) }));
  console.log(`  ${users.length} active members`);

  const previous = loadIndex();
  const rows = [];
  const report = { auto: 0, manual: 0, none: 0, ambiguous: [] };

  for (const { poster, author } of expected) {
    const prev = previous.get(poster);
    if (prev && prev.match === "manual") {
      rows.push({ ...prev, author: author || prev.author });
      report.manual++;
      continue;
    }
    const { best } = matchUser(author, users);
    if (best.length === 1) {
      rows.push({ poster, author, id: best[0].id, name: best[0].name, match: "auto" });
      report.auto++;
    } else {
      if (best.length > 1) report.ambiguous.push({ poster, author, best });
      rows.push({ poster, author, id: "", name: "", match: "none" });
      report.none++;
    }
  }

  rows.sort((a, b) => Number(a.poster) - Number(b.poster));
  const out = [
    "# Poster → presenter's Zulip account. GENERATED by `npm run zulip-users`;",
    "# rows with match=manual are preserved, everything else is recomputed.",
    "# To fix a row by hand: set zulip_user_id + zulip_name and match=manual.",
    "poster,author,zulip_user_id,zulip_name,match",
    ...rows.map((r) => [r.poster, r.author, r.id, r.name, r.match].map(csvCell).join(",")),
  ];
  fs.writeFileSync(INDEX, out.join("\n") + "\n");

  console.log(`\n✓ ${rows.length} posters → ${path.relative(ROOT, INDEX)}`);
  console.log(`  matched: ${report.auto} auto · ${report.manual} manual · ${report.none} unmatched`);
  const unmatched = rows.filter((r) => r.match === "none");
  if (unmatched.length) {
    console.log(`\n⚠ No Zulip account found for:`);
    for (const r of unmatched) console.log(`  - P${r.poster} ${r.author}`);
    console.log(`  They may not have joined yet — re-run later, or fill the row in by hand (match=manual).`);
  }
  if (report.ambiguous.length) {
    console.log(`\n⚠ Ambiguous (left unmatched — pick one by hand):`);
    for (const a of report.ambiguous) {
      console.log(`  - P${a.poster} ${a.author}: ${a.best.map((u) => `${u.name} (${u.id})`).join(" | ")}`);
    }
  }
  console.log("");
}

main().catch((err) => {
  console.error(`\n✗ ${err.message}\n`);
  process.exit(1);
});
