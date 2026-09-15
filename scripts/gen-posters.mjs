#!/usr/bin/env node
/**
 * gen-posters.mjs — build the poster gallery data + thumbnails.
 *
 * Scans static/posters/pdf/*.pdf, generates a first-page thumbnail for each
 * (via poppler's `pdftoppm`), derives title/authors/poster/topic from the
 * filename (overridable via posters/overrides.csv), and writes
 * data/posters.json which Hugo renders into the gallery.
 *
 * Authoritative metadata for poster number, topic and author comes from the
 * ESA posters page (https://www.cosmos.esa.int/web/esa-heliophysics/posters)
 * and is kept in posters/expected.csv. Each run cross-references the ingested
 * posters against that list and reports which posters are still missing.
 *
 * Run locally after adding/removing PDFs:  npm run posters
 * Requires: poppler-utils (`pdftoppm`, `pdfinfo`) on PATH.
 *
 * No npm dependencies — only Node built-ins + shelling out to poppler.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PDF_DIR = path.join(ROOT, "static", "posters", "pdf");
const THUMB_DIR = path.join(ROOT, "static", "posters", "thumbs");
const DATA_FILE = path.join(ROOT, "data", "posters.json");
const OVERRIDES = path.join(ROOT, "posters", "overrides.csv");
const EXPECTED = path.join(ROOT, "posters", "expected.csv");

const THUMB_MAX_PX = 700; // longest edge of the first-page thumbnail
const JPEG_QUALITY = 82;
const UNASSIGNED = "Unassigned";

// ---------------------------------------------------------------------------
// Tooling checks
// ---------------------------------------------------------------------------
function requireTool(bin) {
  try {
    execFileSync(bin, ["-h"], { stdio: "ignore" });
  } catch (err) {
    // pdftoppm/pdfinfo exit non-zero on -h but still exist; only ENOENT is fatal.
    if (err && err.code === "ENOENT") {
      console.error(
        `\n✗ Required tool "${bin}" not found on PATH.\n` +
          `  Install poppler-utils, e.g.:  sudo dnf install poppler-utils\n` +
          `  (macOS: brew install poppler · Debian/Ubuntu: apt install poppler-utils)\n`
      );
      process.exit(1);
    }
  }
}

// ---------------------------------------------------------------------------
// Filename → metadata
// ---------------------------------------------------------------------------
function slugify(name) {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

function humanize(part) {
  return (part || "")
    .replace(/[-_+]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function humanizeAuthors(part) {
  // "+" separates authors, "-" separates words within one author name.
  return (part || "")
    .split("+")
    .map((a) => a.replace(/-/g, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(", ");
}

function normalizeTopic(t) {
  const m = String(t || "").match(/^\s*(\d{1,3})\s*$/);
  return m ? `Topic ${parseInt(m[1], 10)}` : t;
}

/**
 * Recommended convention:  P<n>_T<m>_Lastname-Firstname_Poster-Title.pdf
 *   P<n>   poster number (from the ESA posters list)
 *   T<m>   topic number (1–4, from the ESA posters list)
 * Defensive: any part may be missing; never throws.
 */
function parseFilename(filename) {
  const stem = filename.replace(/\.pdf$/i, "");
  let parts = stem.split("_").filter((p) => p.length > 0);

  let poster = "";
  let topic = null;
  while (parts.length > 0) {
    const head = parts[0];
    const pMatch = head.match(/^p(\d{1,3})$/i);
    const tMatch = head.match(/^(?:t|topic)[-\s]?(\d{1,3})$/i);
    if (pMatch) {
      poster = String(parseInt(pMatch[1], 10));
      parts = parts.slice(1);
    } else if (tMatch) {
      topic = `Topic ${parseInt(tMatch[1], 10)}`;
      parts = parts.slice(1);
    } else {
      break;
    }
  }

  let authors = "";
  let title = "";
  if (parts.length >= 2) {
    authors = humanizeAuthors(parts[0]);
    title = humanize(parts.slice(1).join("_"));
  } else if (parts.length === 1) {
    title = humanize(parts[0]);
  }
  if (!title) title = humanize(stem);

  return {
    poster,
    topic: topic || UNASSIGNED,
    authors,
    title,
    conforming: Boolean(poster || topic) && parts.length >= 2,
  };
}

// ---------------------------------------------------------------------------
// overrides.csv (optional): filename,poster,topic,title,authors
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

function loadOverrides() {
  const map = new Map();
  if (!fs.existsSync(OVERRIDES)) return map;
  const lines = fs.readFileSync(OVERRIDES, "utf8").split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const [filename, poster, topic, title, authors] = parseCsvLine(raw);
    if (!filename || filename.toLowerCase() === "filename") continue; // skip header
    map.set(filename, {
      poster: poster || "",
      topic: topic || "",
      title: title || "",
      authors: authors || "",
    });
  }
  return map;
}

// ---------------------------------------------------------------------------
// expected.csv — the authoritative ESA poster list: poster,topic,authors,title
// Used both as a metadata check and as "which posters are missing" tracking.
// ---------------------------------------------------------------------------
function loadExpected() {
  const list = new Map();
  if (!fs.existsSync(EXPECTED)) return list;
  const lines = fs.readFileSync(EXPECTED, "utf8").split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const [poster, topic, authors, title] = parseCsvLine(raw);
    if (!poster) continue;
    if (poster.toLowerCase() === "poster") continue; // header
    list.set(String(parseInt(poster, 10)), {
      topic,
      authors,
      title,
    });
  }
  return list;
}

// ---------------------------------------------------------------------------
// Thumbnails
// ---------------------------------------------------------------------------
function makeThumb(pdfPath, thumbSlug) {
  const outPrefix = path.join(THUMB_DIR, thumbSlug); // pdftoppm appends ".jpg"
  execFileSync(
    "pdftoppm",
    [
      "-jpeg",
      "-jpegopt", `quality=${JPEG_QUALITY}`,
      "-f", "1", "-l", "1",
      "-scale-to", String(THUMB_MAX_PX),
      "-singlefile",
      pdfPath,
      outPrefix,
    ],
    { stdio: ["ignore", "ignore", "pipe"] }
  );
  return `${thumbSlug}.jpg`;
}

function isStale(pdfPath, thumbPath) {
  if (!fs.existsSync(thumbPath)) return true;
  return fs.statSync(pdfPath).mtimeMs > fs.statSync(thumbPath).mtimeMs;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
  fs.mkdirSync(THUMB_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });

  if (!fs.existsSync(PDF_DIR)) {
    fs.mkdirSync(PDF_DIR, { recursive: true });
  }

  const expected = loadExpected();

  const pdfs = fs
    .readdirSync(PDF_DIR)
    .filter((f) => /\.pdf$/i.test(f))
    .sort();

  if (pdfs.length === 0) {
    fs.writeFileSync(DATA_FILE, "[]\n");
    let pruned = 0;
    for (const f of fs.readdirSync(THUMB_DIR)) {
      if (/\.jpg$/i.test(f)) {
        fs.unlinkSync(path.join(THUMB_DIR, f));
        pruned++;
      }
    }
    console.log(
      `No PDFs in ${path.relative(ROOT, PDF_DIR)}/ — wrote empty gallery.` +
        (pruned ? ` Removed ${pruned} orphaned thumbnail(s).` : "") +
        `\nDrop poster PDFs there and re-run \`npm run posters\`.`
    );
    return;
  }

  requireTool("pdftoppm");

  const overrides = loadOverrides();
  const usedSlugs = new Set();
  const validThumbs = new Set();
  const entries = [];
  let generated = 0;
  let skipped = 0;
  const warnings = [];

  for (const file of pdfs) {
    const pdfPath = path.join(PDF_DIR, file);

    // Unique, stable slug for the thumbnail filename.
    let slug = slugify(file.replace(/\.pdf$/i, "")) || "poster";
    let candidate = slug;
    let n = 2;
    while (usedSlugs.has(candidate)) candidate = `${slug}-${n++}`;
    slug = candidate;
    usedSlugs.add(slug);

    const thumbFile = `${slug}.jpg`;
    const thumbPath = path.join(THUMB_DIR, thumbFile);
    validThumbs.add(thumbFile);

    try {
      if (isStale(pdfPath, thumbPath)) {
        makeThumb(pdfPath, slug);
        generated++;
      } else {
        skipped++;
      }
    } catch (err) {
      warnings.push(`thumbnail failed for "${file}": ${err.message.split("\n")[0]}`);
    }

    const meta = parseFilename(file);
    if (!meta.conforming) {
      warnings.push(`"${file}" does not match P<n>_T<m>_Author_Title — used best-effort parsing`);
    }

    // Authoritative metadata from the ESA list (poster number key). The
    // website is the source of truth for author + topic; the title from the
    // filename usually matches (titles may drift slightly — that's fine).
    if (meta.poster) {
      const exp = expected.get(meta.poster);
      if (exp) {
        if (exp.authors && !meta.authors) meta.authors = exp.authors;
        if (exp.topic) meta.topic = exp.topic;
        if (exp.title && !meta.title) meta.title = exp.title;
      } else {
        warnings.push(`poster #${meta.poster} ("${file}") is not in posters/expected.csv — check the ESA posters page`);
      }
    }

    const ov = overrides.get(file);
    if (ov) {
      if (ov.poster) meta.poster = ov.poster;
      if (ov.topic) meta.topic = ov.topic;
      if (ov.title) meta.title = ov.title;
      if (ov.authors) meta.authors = ov.authors;
    }

    entries.push({
      file,
      thumb: thumbFile,
      slug,
      poster: meta.poster,
      topic: normalizeTopic(meta.topic) || UNASSIGNED,
      title: meta.title,
      authors: meta.authors,
    });
  }

  // Sort by poster number (known posters first, then unknown by title).
  const posterRank = (p) => (p ? parseInt(p, 10) : Number.MAX_SAFE_INTEGER);
  entries.sort((a, b) => {
    const r = posterRank(a.poster) - posterRank(b.poster);
    if (r !== 0) return r;
    return a.title.localeCompare(b.title);
  });

  fs.writeFileSync(DATA_FILE, JSON.stringify(entries, null, 2) + "\n");

  // Prune orphaned thumbnails (PDF removed).
  let pruned = 0;
  for (const f of fs.readdirSync(THUMB_DIR)) {
    if (/\.jpg$/i.test(f) && !validThumbs.has(f)) {
      fs.unlinkSync(path.join(THUMB_DIR, f));
      pruned++;
    }
  }

  // Report
  const byTopic = entries.reduce((acc, e) => {
    acc[e.topic] = (acc[e.topic] || 0) + 1;
    return acc;
  }, {});
  console.log(`\n✓ ${entries.length} posters → ${path.relative(ROOT, DATA_FILE)}`);
  console.log(`  thumbnails: ${generated} generated, ${skipped} reused${pruned ? `, ${pruned} pruned` : ""}`);
  for (const [t, c] of Object.entries(byTopic).sort()) {
    console.log(`    · ${t}: ${c}`);
  }

  // Cross-check against the authoritative ESA list.
  if (expected.size > 0) {
    const have = new Set(entries.map((e) => e.poster).filter(Boolean));
    const missing = [...expected.keys()]
      .map(Number)
      .filter((p) => !have.has(String(p)))
      .sort((a, b) => a - b);
    console.log(`\n📋 Cross-check vs ${path.relative(ROOT, EXPECTED)} (ESA posters page):`);
    console.log(`  expected: ${expected.size} · received: ${have.size} · missing: ${missing.length}`);
    if (missing.length) {
      console.log(`  missing poster #: ${missing.join(", ")}`);
      console.log(`  Tip: copy missing PDFs from posters_raw → ${path.relative(ROOT, PDF_DIR)}/ and re-run.`);
    }
  } else {
    console.log(`\n⚠ No ${path.relative(ROOT, EXPECTED)} — create it so missing posters are tracked.`);
  }

  if (warnings.length) {
    console.log(`\n⚠ ${warnings.length} warning(s):`);
    for (const w of warnings.slice(0, 20)) console.log(`  - ${w}`);
    if (warnings.length > 20) console.log(`  … and ${warnings.length - 20} more`);
    console.log(`  Tip: fix names, or add rows to ${path.relative(ROOT, OVERRIDES)}`);
  }
  console.log("");
}

main();