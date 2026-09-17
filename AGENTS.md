# Ingesting new poster submissions

`posters_raw/` is a symlink to the live Nextcloud submission export (gitignored, not checked in). Each new submission adds a numbered subfolder there, e.g. `posters_raw/220/122 - Upload your poster here (PDF only)/<raw-name>.pdf`.

To publish newly uploaded posters:

1. For each raw PDF not yet in `static/posters/pdf/`, find its correct poster number, topic and author in `posters/expected.csv` (the authoritative ESA list) — **do not trust the number embedded in the raw filename**, submitters sometimes get it wrong (e.g. a file named `50_Swaczyna_Pawel-....pdf` actually turned out to be poster 51). Match by author name / title instead.
2. `cp` (don't `mv` — leave the Nextcloud-synced originals alone) each PDF into `static/posters/pdf/`, renamed to the convention `P<poster>_T<topic>_Lastname-Firstname_Title-Hyphenated.pdf`, title case/punctuation taken from `expected.csv`'s title column with punctuation stripped and spaces turned into hyphens.
3. Watch for duplicate uploads (same poster submitted twice under different submission IDs) — diff with `md5sum` and only copy one.
4. Run `npm run posters` (requires `poppler-utils` — `pdftoppm`/`pdfinfo` — on PATH) to generate thumbnails and rewrite `data/posters.json`.
5. Check the script's console output: it lists any remaining missing poster numbers (cross-checked against `expected.csv`) and any filename-parsing warnings — a warning usually means a rename typo.
