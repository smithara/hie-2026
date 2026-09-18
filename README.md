# ESLAB & Heliophysics in Europe #3 — workshop website

Companion website for the **ESLAB & Heliophysics in Europe #3** workshop
(ESA/ESTEC, Noordwijk — 21–24 September 2026). It presents the key workshop
information and a **browsable gallery of the poster PDFs**, and links back to the
[ESA Cosmos portal](https://www.cosmos.esa.int/web/esa-heliophysics/heliophysics-in-europe-2026)
for registration, abstracts and the full schedule.

Built with [Hugo](https://gohugo.io/) (extended). No JavaScript framework, no CDN —
the whole site is static and self-contained.

---

## Quick start

```bash
hugo server        # local dev at http://localhost:1313  (or: npm run dev)
hugo --gc --minify # production build into ./public       (or: npm run build)
```

Requires **Hugo extended ≥ 0.146** (pinned to `0.162.1` for Netlify — see `netlify.toml`).

---

## Adding posters

Posters are the centrepiece. The workflow is: **crosscheck → copy PDFs → run one command → commit.**

1. New submissions land in **`posters_raw/`** (a symlink to the Nextcloud form
   inbox). Copy each PDF into **`static/posters/pdf/`** — leave the originals in place.

2. **Crosscheck each poster against the authoritative ESA list** at
   https://www.cosmos.esa.int/web/esa-heliophysics/posters (and, for Session 2
   details, https://www.cosmos.esa.int/web/esa-heliophysics/session-2-schedule).
   Titles may drift slightly from the uploaded filename — that's fine. Use the
   website to assign the correct **poster number, topic number and author**, and
   keep `posters/expected.csv` in sync (the generator uses it to report which
   posters are still missing).

3. Run the generator:

   ```bash
   npm run posters      # = node scripts/gen-posters.mjs
   ```

   This creates a first-page thumbnail for each PDF in `static/posters/thumbs/`
   and (re)writes `data/posters.json`, which drives the gallery. It only
   regenerates thumbnails whose PDF changed, and prunes thumbnails for removed
   PDFs. Requires **poppler-utils** (`pdftoppm`) on your machine:

   - Fedora: `sudo dnf install poppler-utils`
   - Debian/Ubuntu: `sudo apt install poppler-utils`
   - macOS: `brew install poppler`

4. Commit the new/changed PDFs, thumbnails and `data/posters.json`, then push.

> Netlify does **not** need poppler — it just runs `hugo`. Thumbnail generation
> happens on your machine and the results are committed. Until any PDFs are added,
> the gallery shows a friendly "coming soon" state.

### Filename convention (metadata comes from the filename)

Titles, authors, poster number and topic are derived from each PDF's filename. Name the
uploads like this for the best results:

```
P<n>_T<m>_Lastname-Firstname_Poster-Title-Words.pdf
```

Examples:

| Filename | Poster | Topic | Authors | Title |
| --- | --- | --- | --- | --- |
| `P20_T1_Froment-Clara_Observation-of-...-dynamics.pdf` | 20 | Topic 1 | Clara Froment | Observation of … dynamics |
| `P59_T2_Guarnaccia-Federica_The-SMOS-mission-....pdf` | 59 | Topic 2 | Federica Guarnaccia | The SMOS mission … |
| `anything-else.pdf` | — | Unassigned | — | Anything Else |

Rules:
- Leading `P<n>` → poster number (optional).
- Next `T<m>` / `Topic<m>` → topic badge (optional).
- Next `_`-separated chunk → author(s). Use `-` between name words and `+` between
  co-authors.
- The remainder → the title (`-` and `_` become spaces; ALL-CAPS acronyms are kept).
- Posters with a poster-number entry in `posters/expected.csv` take their author,
  topic (and any missing title) from that file — the authoritative ESA list wins
  over the filename.
- Non-conforming names still work — the whole filename becomes the title and the
  topic is "Unassigned". The generator prints a warning for each.

### Tracking missing posters — `posters/expected.csv`

`posters/expected.csv` holds the authoritative poster list (poster number, topic,
author, title) transcribed from the ESA posters page. Every `npm run posters` run
cross-references the PDFs in `static/posters/pdf/` against it and prints **received
vs missing**, listing the missing poster numbers. Import new submissions from
`posters_raw/` until the missing list is empty (or as intended).

### Fixing individual posters — `posters/overrides.csv`

If a filename parses badly, don't rename it — add a row to `posters/overrides.csv`
to override any field (matched on the exact PDF filename; blank fields keep the
derived value):

```csv
filename,poster,topic,title,authors
P3_T2_weird-name.pdf,3,Topic 2,"Magnetic reconnection in the magnetotail","A. Author, B. Author"
```

Re-run `npm run posters` after editing.

---

## Deploying to Netlify

The repo is deploy-ready (`netlify.toml` sets the Hugo version, build command and
publish directory). Two options:

**A. Connect the Git repo (recommended)** — push this repo to GitHub/GitLab, then in
the Netlify dashboard: *Add new site → Import an existing project* and pick the repo.
Netlify reads `netlify.toml`; no extra settings needed. Every push redeploys.

**B. Manual CLI deploy** — from this directory:

```bash
hugo --gc --minify
netlify deploy --prod --dir=public
```

After the first deploy, set your real domain in `hugo.toml` (`baseURL`) so
absolute URLs (sitemap, Open Graph) are correct, then redeploy.

## Deploying to GitHub Pages

`.github/workflows/hugo.yml` builds the site with Hugo and publishes it to GitHub
Pages on every push to `main` (or manually via *Actions → Deploy Hugo site to
GitHub Pages → Run workflow*). It overrides `baseURL` at build time to match the
Pages URL, so it works regardless of the `baseURL` set in `hugo.toml` for Netlify.

One-time setup: in the repo settings, go to **Settings → Pages** and set
**Source** to **GitHub Actions**. The workflow needs no further configuration —
it reuses the same Hugo version pinned in `netlify.toml`.

### ⚠️ A note on poster file sizes

A1 poster PDFs can be large (often 5–50 MB each). Sixty of them can add up to well
over a gigabyte, which:

- bloats the Git repo (Git handles large binaries poorly), and
- consumes Netlify bandwidth (the free tier includes ~100 GB/month).

Recommendations, in order of preference:
1. Ask presenters for a **web-optimised / flattened** PDF (often 10× smaller).
2. Track the PDFs with **[Git LFS](https://git-lfs.com/)**
   (`git lfs track "static/posters/pdf/*.pdf"`). Note: git-lfs may need installing
   (`dnf install git-lfs` / `brew install git-lfs`), and confirm your Git host +
   Netlify support it.
3. If bandwidth is a concern, host the raw PDFs on ESA/Nextcloud and change the
   gallery links to point there (edit `layouts/posters/list.html`).

---

## Project layout

```
hugo.toml              Site config + workshop facts (dates, venue, ESA links)
netlify.toml           Netlify build config (Hugo version pinned)
scripts/gen-posters.mjs  PDF → thumbnails + data/posters.json  (run via npm run posters)
data/posters.json      GENERATED gallery data — do not edit by hand
content/               Home + posters page copy (edit the sessions list in _index.md)
layouts/               Templates (base, home, poster gallery, partials, 404)
assets/                main.css + gallery.js (bundled & fingerprinted by Hugo)
static/posters/pdf/    ← put poster PDFs here
static/posters/thumbs/ ← generated thumbnails
posters/expected.csv   Authoritative ESA poster list (also tracks missing posters)
posters/overrides.csv  Optional per-poster metadata corrections
```

To edit workshop details (dates, venue, deadlines, session descriptions), see
`hugo.toml` (`[params]`) and the `sessions:` list in `content/_index.md`.
