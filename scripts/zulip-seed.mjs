#!/usr/bin/env node
/**
 * zulip-seed.mjs — create each poster's discussion topic in Zulip.
 *
 * For every poster in data/posters.json whose topic does not exist yet in the
 * "<year>: Posters" channel, the bot posts ONE seed message that @-mentions the
 * presenter (from posters/zulip-users.csv), so they are notified and — with
 * Zulip's default "follow topics where I'm mentioned" — follow the topic from
 * then on. The topic name is the same deterministic one the site links to.
 *
 * DRY RUN BY DEFAULT: prints what it would post and exits. Nothing is sent to
 * Zulip unless you pass --post.
 *
 *   npm run zulip-seed                # dry run (default)
 *   npm run zulip-seed -- --post      # actually post
 *   npm run zulip-seed -- --post --limit 1   # post just the first one (smoke test)
 *   npm run zulip-seed -- --all       # include posters with no matched presenter
 *
 * Idempotent: existing topics are skipped, so re-run as more presenters join
 * Zulip and get matched. By default posters whose presenter is unmatched are
 * skipped too (a topic seeded without a mention can't be "re-seeded" later).
 *
 * Needs: .zuliprc (gitignored) — the bot must be subscribed to the channel.
 * No npm dependencies — Node ≥18 built-ins only.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_FILE = path.join(ROOT, "data", "posters.json");
const INDEX = path.join(ROOT, "posters", "zulip-users.csv");
const HUGO_TOML = path.join(ROOT, "hugo.toml");
const CNAME = path.join(ROOT, "static", "CNAME");

const args = process.argv.slice(2);
const POST = args.includes("--post");
const ALL = args.includes("--all");
const limitIdx = args.indexOf("--limit");
const LIMIT = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : Infinity;

// ---------------------------------------------------------------------------
// Config: .zuliprc + the [params.zulip] block of hugo.toml + site URL
// ---------------------------------------------------------------------------
function loadZuliprc() {
  const candidates = [
    process.env.ZULIPRC,
    path.join(ROOT, ".zuliprc"),
    path.join(os.homedir(), ".zuliprc"),
  ].filter(Boolean);
  const file = candidates.find((f) => fs.existsSync(f));
  if (!file) {
    console.error(`\n✗ No .zuliprc found (looked in: ${candidates.join(", ")}).\n`);
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

// Minimal read of hugo.toml — only the [params.zulip] table (keep hugo.toml the
// single source of truth for channel + id; no TOML parser needed for this).
function loadSiteConfig() {
  const toml = fs.readFileSync(HUGO_TOML, "utf8");
  const block = toml.split(/^\s*\[params\.zulip\]\s*$/m)[1]?.split(/^\s*\[/m)[0] || "";
  const get = (key) => block.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, "m"))?.[1] || "";
  const zulip = { org: get("org"), channel: get("channel"), channelId: get("channelId") };
  if (!zulip.channel || !zulip.channelId) {
    console.error(`✗ hugo.toml [params.zulip] needs channel and channelId set`);
    process.exit(1);
  }
  // Public site URL: the GitHub Pages custom domain if present, else baseURL.
  let siteUrl = toml.match(/^\s*baseURL\s*=\s*"([^"]*)"/m)?.[1] || "";
  if (fs.existsSync(CNAME)) {
    const host = fs.readFileSync(CNAME, "utf8").trim();
    if (host) siteUrl = `https://${host}/`;
  }
  return { zulip, siteUrl: siteUrl.replace(/\/+$/, "") };
}

// ---------------------------------------------------------------------------
// Zulip API
// ---------------------------------------------------------------------------
function authHeader(cfg) {
  return `Basic ${Buffer.from(`${cfg.email}:${cfg.key}`).toString("base64")}`;
}

async function zulipGet(cfg, endpoint) {
  const res = await fetch(`${cfg.site}/api/v1/${endpoint}`, {
    headers: { Authorization: authHeader(cfg) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.result !== "success") {
    throw new Error(`GET ${endpoint} → ${res.status} ${body.msg || res.statusText}`);
  }
  return body;
}

async function zulipPost(cfg, endpoint, params) {
  const res = await fetch(`${cfg.site}/api/v1/${endpoint}`, {
    method: "POST",
    headers: {
      Authorization: authHeader(cfg),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(params),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.result !== "success") {
    throw new Error(`POST ${endpoint} → ${res.status} ${body.msg || res.statusText}`);
  }
  return body;
}

// ---------------------------------------------------------------------------
// zulip-users.csv: poster,author,zulip_user_id,zulip_name,match
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

function loadPresenters() {
  const map = new Map();
  if (!fs.existsSync(INDEX)) {
    console.error(`✗ ${path.relative(ROOT, INDEX)} not found — run \`npm run zulip-users\` first`);
    process.exit(1);
  }
  for (const raw of fs.readFileSync(INDEX, "utf8").split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    const [poster, author, id, name] = parseCsvLine(raw);
    if (!poster || poster.toLowerCase() === "poster") continue;
    if (id && name) map.set(String(parseInt(poster, 10)), { id, name, author });
  }
  return map;
}

// ---------------------------------------------------------------------------
// Seed message
// ---------------------------------------------------------------------------
function seedMessage(p, presenter, siteUrl) {
  const who = presenter ? `@**${presenter.name}|${presenter.id}**` : `**${p.authors}**`;
  const num = p.poster ? `Poster ${p.poster}` : "Poster";
  const pdf = `${siteUrl}/posters/pdf/${encodeURIComponent(p.file)}`;
  const gallery = `${siteUrl}/posters/#${p.slug}`;
  return [
    `${who} — this is the discussion topic for your poster.`,
    ``,
    `**${num} · ${p.topic}: ${p.title}**`,
    `📄 [Poster PDF](${pdf}) · 🖼️ [Gallery](${gallery})`,
    ``,
    `Ask questions and discuss the poster here — the presenter is notified when mentioned.`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const cfg = loadZuliprc();
  const { zulip, siteUrl } = loadSiteConfig();
  const presenters = loadPresenters();
  const posters = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  if (posters.length === 0) {
    console.log(`Nothing in ${path.relative(ROOT, DATA_FILE)} — run \`npm run posters\` first.`);
    return;
  }

  console.log(`→ ${cfg.site} as ${cfg.email}`);
  console.log(`  channel: "${zulip.channel}" (#${zulip.channelId}) · site: ${siteUrl}`);
  console.log(POST ? `  MODE: POST — messages will be sent` : `  MODE: dry run — nothing will be sent (add --post to send)`);

  // Existing topics in the channel (needs the bot to be subscribed).
  let existing;
  try {
    const { topics } = await zulipGet(cfg, `users/me/${zulip.channelId}/topics`);
    existing = new Set(topics.map((t) => t.name.toLowerCase()));
  } catch (err) {
    throw new Error(`${err.message}\n  Is the bot subscribed to "${zulip.channel}"?`);
  }
  console.log(`  ${existing.size} topic(s) already exist in the channel`);

  const plan = [];
  const skipped = { exists: [], unmatched: [], noTopic: [] };
  for (const p of posters) {
    if (!p.zulipTopic) {
      skipped.noTopic.push(p);
      continue;
    }
    if (existing.has(p.zulipTopic.toLowerCase())) {
      skipped.exists.push(p);
      continue;
    }
    const presenter = presenters.get(String(p.poster));
    if (!presenter && !ALL) {
      skipped.unmatched.push(p);
      continue;
    }
    plan.push({ p, presenter, content: seedMessage(p, presenter, siteUrl) });
  }

  const todo = plan.slice(0, LIMIT);
  console.log(
    `\n  to seed: ${todo.length}${plan.length > todo.length ? ` (of ${plan.length}, --limit)` : ""}` +
      ` · already exist: ${skipped.exists.length} · presenter unmatched: ${skipped.unmatched.length}` +
      (skipped.noTopic.length ? ` · no topic name: ${skipped.noTopic.length}` : "")
  );
  if (skipped.unmatched.length && !ALL) {
    console.log(`  (unmatched presenters are skipped so they can be seeded with a mention later; --all overrides)`);
    for (const p of skipped.unmatched) console.log(`    - P${p.poster} ${p.authors}`);
  }

  let sent = 0;
  for (const { p, content } of todo) {
    console.log(`\n── P${p.poster} → topic "${p.zulipTopic}"`);
    console.log(content.replace(/^/gm, "   │ "));
    if (!POST) continue;
    await zulipPost(cfg, "messages", {
      type: "stream",
      to: zulip.channelId,
      topic: p.zulipTopic,
      content,
    });
    sent++;
    await new Promise((r) => setTimeout(r, 250)); // be gentle with the API
  }

  console.log(POST ? `\n✓ posted ${sent} seed message(s)\n` : `\n✓ dry run complete — ${todo.length} message(s) would be posted\n`);
}

main().catch((err) => {
  console.error(`\n✗ ${err.message}\n`);
  process.exit(1);
});
