# Ingesting new poster submissions

`posters_raw/` is a symlink to the live Nextcloud submission export (gitignored, not checked in). Each new submission adds a numbered subfolder there, e.g. `posters_raw/220/122 - Upload your poster here (PDF only)/<raw-name>.pdf`.

To publish newly uploaded posters:

1. For each raw PDF not yet in `static/posters/pdf/`, find its correct poster number, topic and author in `posters/expected.csv` (the authoritative ESA list) — **do not trust the number embedded in the raw filename**, submitters sometimes get it wrong (e.g. a file named `50_Swaczyna_Pawel-....pdf` actually turned out to be poster 51). Match by author name / title instead.
2. `cp` (don't `mv` — leave the Nextcloud-synced originals alone) each PDF into `static/posters/pdf/`, renamed to the convention `P<poster>_T<topic>_Lastname-Firstname_Title-Hyphenated.pdf`, title case/punctuation taken from `expected.csv`'s title column with punctuation stripped and spaces turned into hyphens.
3. Watch for duplicate uploads (same poster submitted twice under different submission IDs) — diff with `md5sum` and only copy one. This includes posters **already published**: a presenter can resubmit a newer PDF under a fresh submission ID after an earlier version was already ingested (e.g. poster #53 was re-uploaded a day after the first copy had already been published — the site kept serving the stale one until caught). Every ingest run, cross-reference *all* poster numbers found in `posters_raw/` (not just newly-missing ones) against what's currently in `static/posters/pdf/`, and replace with the newest (`mtime`) raw file if it differs (`md5sum`) from what's live.
4. Run `npm run posters` (requires `poppler-utils` — `pdftoppm`/`pdfinfo` — on PATH) to generate thumbnails and rewrite `data/posters.json`.
5. Check the script's console output: it lists any remaining missing poster numbers (cross-checked against `expected.csv`) and any filename-parsing warnings — a warning usually means a rename typo.
6. Run `npm run zulip-users` to refresh `posters/zulip-users.csv`, the poster → presenter Zulip account index (see below). Report the "unmatched" list to the user; do not try to guess matches.
7. Print the next steps for the user to publish (do not run these yourself):
   ```
   hugo --gc --minify
   netlify deploy --prod --dir=public
   ```

# Zulip discussion topics and the presenter index

Every poster card links to a topic in the `2026: Posters` channel on https://euro-helio.zulipchat.com (config in `hugo.toml` `[params.zulip]`; topic names are generated into `data/posters.json` by `npm run posters`, so they change only if a poster's number/author/title changes).

`posters/zulip-users.csv` maps each poster in `expected.csv` to the presenter's Zulip user id, so a seed message can @-mention them. Rules:

- Refresh it with `npm run zulip-users` whenever `expected.csv` changes or as part of a poster ingest (people join Zulip over time, so unmatched rows get another chance). It uses the bot credentials in `.zuliprc` (repo root, gitignored — never commit or print the key) and only **reads** from Zulip.
- Rows with `match=manual` are hand-corrected and are preserved verbatim; `auto` rows are recomputed; `none` rows are unmatched. If the user tells you a match (e.g. "P3 is George Balasis"), edit the row, set `match=manual`, and re-run to confirm it survives.
- `npm run zulip-seed` (`scripts/zulip-seed.mjs`) creates the missing discussion topics: one bot message per received poster, @-mentioning the presenter from the index. It is a **dry run by default** and idempotent (existing topics and unmatched presenters are skipped). You may run the dry run to show the user what would be posted.
- The bot must **not send any Zulip messages** (`--post`, or anything else) unless the user explicitly asks in that session. Treat any posting as outward-facing: show the dry-run output and confirm before running `--post`.
- Node's `fetch` ignores proxy env vars; if `npm run zulip-users` fails with "fetch failed" inside a sandboxed shell, run it outside the sandbox — it is a read-only call.
