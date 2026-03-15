# Charted Roots — Claude Context

## What this repo is

This is the **Charted Roots project** for the Gal-Patan family tree (~960 people). It contains the Obsidian vault, migration scripts, and Quartz static website, all under one git repository.

Root: `~/git/gal-roots/`

---

## Directory structure

```
gal-roots/
├── obsidian/                  ← Obsidian vault (migration output)
│   ├── People/                ← ~958 person notes
│   ├── attachments/
│   │   ├── pictures/          ← photos from epatan + ygtree
│   │   └── docs/              ← linked documents
│   ├── Charted Roots/         ← Charted Roots plugin data
│   ├── Elie-Patan-Family-Website.md
│   └── Yossi-Gal-Family-Website.md
├── scripts/                   ← migration + maintenance scripts
│   ├── migration/
│   │   ├── migrate_cr.py      ← orchestrator
│   │   ├── verify_cr.py       ← verifier
│   │   ├── merger.py
│   │   ├── models.py
│   │   ├── name_utils.py
│   │   ├── parsers.py
│   │   ├── writers_cr.py
│   │   └── merge_config.json
│   └── dedup_pictures.py      ← iCloud duplicate cleaner
└── website/                   ← Quartz static site
    ├── content/               ← synced from obsidian/ at build time (NOT in git)
    ├── public/                ← built output (NOT in git)
    ├── quartz/                ← Quartz framework + customisations
    └── quartz.config.ts
```

---

## Source data

| Tree | Path | Size |
|------|------|------|
| `epatan` | `/Users/tamirgal/git/epatan` | 650 people, 190 families, 1,140 photos |
| `ygtree` | `/Users/tamirgal/git/ygtree` | ~325 people, ~100 families, ~379 photos |

Both use the same GenoPro HTML export format (`ind*.htm` = persons, `fam*.htm` = families).

---

## Running the migration

All commands are run from `~/git/gal-roots/`.

### Quick run (merged trees)

```bash
cd ~/git/gal-roots

# Clear old notes first
find obsidian/People -name "*.md" -delete

# Run migration
python3 -m scripts.migration.migrate_cr \
  /Users/tamirgal/git/epatan \
  obsidian \
  --secondary /Users/tamirgal/git/ygtree \
  --config scripts/migration/merge_config.json \
  --report /tmp/merge_report.md
```

**IMPORTANT:** Use `find -delete` (not `rm -f glob`) — shell glob expansion fails with spaces in filenames.

### Verify after migration

```bash
cd ~/git/gal-roots
python3 -m scripts.migration.verify_cr \
  /Users/tamirgal/git/epatan \
  obsidian
```

Exit 0 = all correct. Exit 1 = issues found.

**Known issue:** If Obsidian is open during migration, the Charted Roots plugin may modify freshly-written notes (adding `children:` + stripping YAML date quotes + in rare cases removing `father`/`mother` fields). For a fully clean run, **close Obsidian before running the migration**.

### Run tests

```bash
cd ~/git/gal-roots
python3 -m pytest tests/migration/ -v
```

---

## Script architecture

| File | Purpose |
|------|---------|
| `scripts/migration/models.py` | `PersonRecord`, `FamilyRecord`, `PhotoEntry` dataclasses |
| `scripts/migration/parsers.py` | `parse_person(path)`, `parse_family(path)`, `parse_birth_date()` |
| `scripts/migration/name_utils.py` | `build_person_filenames()` — collision-safe filename generation |
| `scripts/migration/merger.py` | 3-tier identity matching; merges two trees into one set of records |
| `scripts/migration/migrate_cr.py` | Orchestrator: 3-pass pipeline → People/ notes, document notes, landing pages |
| `scripts/migration/writers_cr.py` | Writes person notes in Charted Roots frontmatter format |
| `scripts/migration/verify_cr.py` | Field-by-field verification of all generated notes |
| `scripts/migration/merge_config.json` | Per-tree overrides and manual match/non-match rules |
| `scripts/dedup_pictures.py` | Removes iCloud-created duplicate photos; updates `media:` refs in notes |
| `scripts/build_website.sh` | Syncs `obsidian/` → `website/content/` and runs Quartz build |

### merge_config.json

Version-1 format with three sections:
- `source_overrides`: list of full names to always take from the `epatan` (primary) tree
- `match_overrides`: list of `{ygtree, epatan}` pairs to force-match despite name differences
- `forced_non_matches`: list of `{ygtree, epatan}` pairs to force-separate despite name similarity

```json
{
  "version": 1,
  "source_overrides": ["Joseph Goldstein Gal", "Chaya Farkas Goldstein"],
  "match_overrides": [
    {"ygtree": "ind00003", "epatan": "ind00005"},
    {"ygtree": "ind00313", "epatan": "ind00004"},
    {"ygtree": "ind00314", "epatan": "ind00003"}
  ],
  "forced_non_matches": []
}
```

### _EXTRA_DOC_LINKS (in migrate_cr.py)

Documents not linked from any person page in the source HTML are added via this dict:

```python
_EXTRA_DOC_LINKS: Dict[str, List[str]] = {
    "ind00001": ["attachments/docs/hebrew-memories"],  # Elie Patan → Hebrew memories
}
```

### Landing pages (in migrate_cr.py)

`write_landing_pages()` writes two vault-root notes from the original source sites:

| Note | Source | Images copied |
|------|--------|---------------|
| `Elie-Patan-Family-Website.md` | `epatan/home.htm` | `Image3.gif` → `epatan-landing-tree.gif`, `Image4.gif` → `epatan-landing-portrait.gif` |
| `Yossi-Gal-Family-Website.md` | `ygtree/home.htm` | none |

Content is stored as `_EPATAN_LANDING` / `_YGTREE_LANDING` string constants in `migrate_cr.py`.

---

## Charted Roots schema

Person notes live in `obsidian/People/<filename>.md`. Key frontmatter fields:

```yaml
cr_id: ind00001
name: Elie Patan
father: "[[People/Ezra-Patan]]"
father_id: ind00015
mother: "[[People/Victoria-Sasson-Patan]]"
mother_id: ind00039
spouse1: "[[People/Mary-Abada-Patan]]"
spouse1_id: ind00147
spouse1_marriage_status: current
born: "1928-05-29"
sex: male
media:
  - "[[attachments/pictures/portrait.jpg]]"
children:
  - "[[People/Sami-Patan]]"
children_id:
  - ind00004
research_level: 2
```

### Important schema notes
- **`spouse` format**: indexed flat fields (`spouse1`, `spouse1_id`, `spouse1_marriage_status`, `spouse2`, ...) — NOT a YAML list.
- **`*_id` fields**: primary keys the Charted Roots plugin uses for person lookup.
- **`children` + `children_id`**: pre-written by migration to avoid alphabetical startup race condition.
- **`born`**: always a quoted YAML string (prevents year-only values from being parsed as integers).
- **`sex`**: omitted entirely if unknown.
- **`media`**: wikilink with `attachments/pictures/` prefix, URL-decoded filename.
- **`research_level`**: `2` = bio + (date or portrait), `1` = date or portrait only, `0` = name only.
- **`marriage_status` mapping**: `married`/`cohabiting` → `current`, `divorced` → `divorced`, `separated` → `separated`, anything else → `unknown`.

---

## Quartz static website

The vault is published as a static website using [Quartz](https://quartz.jzhao.xyz/).
Quartz lives at `~/git/gal-roots/website/`.

**IMPORTANT:** `website/content/` must NOT be in `.gitignore` — Quartz uses globby's `isGitIgnored()` to scan files, and if `content/` is git-ignored, Quartz silently finds 0 files. `content/` is simply left untracked.

### Full regeneration (migration + website)

```bash
cd ~/git/gal-roots

# 1. Re-run migration
find obsidian/People -name "*.md" -delete
python3 -m scripts.migration.migrate_cr \
  /Users/tamirgal/git/epatan \
  obsidian \
  --secondary /Users/tamirgal/git/ygtree \
  --config scripts/migration/merge_config.json \
  --report /tmp/merge_report.md

# 2. Sync fresh content into website/
rm -rf website/content/People website/content/attachments
rsync -a obsidian/People/ website/content/People/
rsync -a obsidian/attachments/ website/content/attachments/
cp obsidian/Elie-Patan-Family-Website.md website/content/
cp obsidian/Yossi-Gal-Family-Website.md website/content/

# 3. Build the site
rm -rf website/public
cd website && node quartz/bootstrap-cli.mjs build
```

Expected output: ~963 notes parsed, ~3,420 files emitted to `website/public/`.

### Website-only rebuild (no migration)

```bash
~/git/gal-roots/scripts/build_website.sh
```

### Preview locally

```bash
cd ~/git/gal-roots/website/public && npx serve@14 -p 9090
```

Open **http://localhost:9090** in your browser.
Person pages are at `/People/<filename>` (e.g. `/People/Elie-Patan`).

### Notes
- Use `npx serve@14` (not Python's `http.server`) — Python's server doesn't handle extensionless URLs and returns 404 for all person pages.
- `npx quartz build --serve` (Quartz's own dev server) crashes on Node v25 due to a WebSocket conflict — use the two-step build + serve approach above instead.
- Use `node quartz/bootstrap-cli.mjs build` (not `npx quartz build`) — `npx` doesn't wire up the local bin symlink correctly in this setup.
- The home page is at `~/git/gal-roots/website/content/index.md`.

### Quartz customisations (in `~/git/gal-roots/website/`)

| File | Change |
|------|--------|
| `quartz/components/ContentMeta.tsx` | Shows `Born: <date>` and `sex` on person pages (uses `globalThis.Date` to avoid shadowing the `./Date` component import) |
| `quartz/components/ArticleTitle.tsx` | Falls back to `name:` frontmatter when `title:` is absent |
| `quartz/plugins/transformers/frontmatter.ts` | Uses `name:` as title fallback before `file.stem` — fixes search, graph, explorer, browser tab |

---

## iCloud duplicate handling

iCloud sync can create duplicate files in two places, both using a `Name N.ext` pattern (e.g. `photo 3.jpg`, `Asaf-Gal 3.md`). These accumulate silently and should be cleaned up periodically.

### Duplicate pictures (`obsidian/attachments/pictures/`)

```bash
cd ~/git/gal-roots

# Dry-run first (safe, no changes)
python3 scripts/dedup_pictures.py

# Apply (deletes redundant files, updates media: refs in notes)
python3 scripts/dedup_pictures.py --execute
```

The script hashes every file, groups by MD5, keeps the most-referenced canonical copy per group, updates any `media:` wikilinks in `obsidian/People/` notes, then deletes the rest.

### Duplicate notes (`obsidian/People/`)

iCloud creates `Name 3.md` copies alongside the original `Name.md` migration output.

```bash
# Preview
find obsidian/People -name "* 3.md" -print | wc -l

# Delete all iCloud duplicate notes
find obsidian/People -name "* 3.md" -delete
```

**Note:** Re-running the full migration clears all notes including iCloud duplicates, so dedup is only needed when skipping a full re-migration.

---

## Obsidian plugin

**Charted Roots** is installed in this vault via BRAT (not in official community plugins list).
GitHub: `https://github.com/banisterious/obsidian-charted-roots`
