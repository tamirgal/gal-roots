#!/usr/bin/env python3
"""
Migration script: GenoPro HTML export → Charted Roots Obsidian vault.

Usage:
    python3 -m scripts.migration.migrate_cr <source_dir> <vault_dir>
    python3 -m scripts.migration.migrate_cr <source_dir> <vault_dir> \\
        --secondary <ygtree_dir> --config merge_config.json [--report /tmp/merge.md]

Example:
    python3 -m scripts.migration.migrate_cr /Users/tamirgal/git/epatan \\
        "/Users/tamirgal/Library/Mobile Documents/iCloud~md~obsidian/Documents/roots"
"""
import argparse
import re
import shutil
import sys
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from urllib.parse import unquote

from .merger import MergeConfig, format_report, load_merge_config, merge_trees
from .models import FamilyRecord, PersonRecord
from .name_utils import build_person_filenames
from .parsers import parse_family, parse_person
from .writers_cr import write_person_note_cr

_EPATAN_LANDING = """\
---
title: Elie Patan Family Website — Introduction
tags: [document, introduction, epatan]
---

![[attachments/pictures/epatan-landing-tree.gif]] ![[attachments/pictures/epatan-landing-portrait.gif]]

*Introduction page from [[People/Elie-Patan-ind00592|Elie Patan]]'s original family website, started May 2002.*

---

## English

You are welcome to navigate between the pages of this site, and see details about any member of the family.

- On the bottom of each individual page, there are pictures displayed in thumbnail size. Click on each one for viewing in full size.
- On the left side of the page, you have 3 indexes. Scroll and click on any name to display the page you are looking for.
- As on all internet pages, there are many hyperlinks, so you can navigate from one person or one family to another.

**3 Indexes are at your disposal:**

1. Name Index — sorted alphabetically by last name
2. Family Index — sorted alphabetically by father's last name
3. Photo Index — sorted alphabetically by last name

I began in May 2002. Starting with about a dozen families, today this folder contains nearly **658 individuals, 190 families and more than 1,264 pictures** — the family grows!

Each time I read it, I feel the need to correct, to add a picture, some comments, and other forgotten details. So, my dears, if you find some errors or mistakes, or even if you want to modify and add some comments, or anything else, please don't hesitate — contact me!

> Elie Patan · 55 Jabotinsky St., Ramat-Gan, Israel
> Tel: +972-3-7511025 · Email: sf_epatan@bezeqint.net

---

## Français

Vous êtes invités à naviguer entre les pages de ce site, et voir les détails concernant les membres de la famille.

- En bas de la page individuelle de chacun, se trouvent les photos le concernant, affichées en petit format. Cliquez sur chaque photo afin de la voir en grandes dimensions.
- À gauche de la page, il y a 3 index à votre disposition. Cherchez le nom, cliquez pour étaler la page voulue.
- Comme dans toutes les pages d'internet, il y a plein de « liens », ainsi vous pouvez naviguer d'une personne à l'autre, et d'une famille à l'autre.

**3 Index sont à votre disposition :**

1. Name Index — par ordre alphabétique du nom de famille
2. Family Index — par ordre alphabétique du nom du père de famille
3. Photo Index — par ordre alphabétique du nom de famille

J'ai commencé au mois de mai 2002. Commençant avec à peine une dizaine de familles, j'en suis arrivé à presque **658 individus, 190 familles et plus de 1 264 photos** — eh oui, la famille grandit !

Chaque fois que je visite le site, je sens le besoin de corriger, d'y ajouter certains détails oubliés. Si vous trouvez des erreurs ou si vous voulez ajouter des photos, ou vos opinions et commentaires, n'hésitez pas à me contacter.

> Elie Patan · 55 rue Jabotinsky, Ramat-Gan, Israël
> Tél : +972-3-7511025 · Email : sf_epatan@bezeqint.net

---

## עברית

אתם מוזמנים לגלוש בין דפי אתר זה, ולקרוא כל מידע השייך לכל אחד מהמשפחה.

- בתחתית הדף האישי, יש תמונות בגודל קטן. לחצו על התמונה להציגה במידות גדולות.
- בצד שמאל, ישנם 3 אינדקסים. לחיצה על השם המבוקש פותחת הדף השייך לו.
- כמו בכל דפי אינטרנט, יש מלא קישורים לגלישה בין אדם לשני ובין משפחה לשניה.

**ישנם 3 אינדקסים לרשותכם:**

1. Name Index — לפי סדר אלפביתי לועזי של שמות משפחה
2. Family Index — לפי סדר אלפביתי לועזי של שם משפחה של האבא
3. Photo Index — לפי סדר אלפביתי לועזי של שמות משפחה

התחלתי בחודש מאי 2002 עם כמה עשרות משפחות. היום אילן זה מכיל בערך **658 אנשים, 190 משפחות ומעל ל-1,264 תמונות**.

אם תמצאו שגיאות או טעויות, אל תהססו ותקשרו אלי.

> אלי פאטאן · ג'בוטינסקי 55, רמת-גן, ישראל
> דואר אלקטרוני: sf_epatan@bezeqint.net
"""

_YGTREE_LANDING = """\
---
title: Yossi Gal Family Website — Introduction
tags: [document, introduction, ygtree]
---

*Introduction page from [[People/Joseph-Goldstein-Gal|Yossi Gal]]'s original family website. Written November 2007.*

---

## Shalom and Welcome

My name is [[People/Joseph-Goldstein-Gal|Joseph Goldstein Gal]], known as Yossi. I'm the son of [[People/Moshe-Goldstein|Moshe Goldstein]] from Uzhgorod (Ungvar) and [[People/Chaya-Farkas-Goldstein|Chaya Farkas]] from Tyachiv (Técső). I'm also related through my grandmothers to the Klein family from Uzhgorod and the Aharon family from Tyachiv.

This is our first attempt to collect and record information about our families and ancestors. We would like to use the Internet to collect and share information among ourselves.

The idea is simple: we wanted to get to know our roots and past, and especially to learn about those who did not survive the Holocaust and WW2. This site assists with that effort. Still, there are many pieces missing — we did not get a chance to speak with most of the family members, we do not have access to formal records, and therefore some of the information was assumed or given to us by third parties.

## The Three Phases

**Phase 1** — Identify and record every member of the family with basic and key data, and at least one photo. Although we have made nice progress, many members are still missing, most persons have no information at all, and others are still without a single photo.

**Phase 2** — Tell the story of each of us. We especially want to focus on our ancestors who lived in Eastern Europe from the 19th century through 1945, the end of WW2. *(I urge each one of you to visit the pages of our older generation. Some of their stories are inspiring and most of them give you another perspective on life.)*

**Phase 3** — Try to find further and deeper roots of the family. So far we have managed to identify **5 generations of the Klein / Aharon families**, from about 1860 till today — around **140 years**.

## How You Can Help

It is beyond the capacity of one person to do all of this alone. Please visit your own page or any other page. Check the information, the spelling, the photos, or any other data that is there or missing. Help us complete the project by sending your comments.

You are welcome to forward this site to any family member (but please do so consciously, thinking about our privacy). Send your comments, details, stories and photos to:

> josephgal@myrealbox.com

Please also send your own homepage and email address — it will be included in the distribution list for communication and newsletters.

## About This Site

This site was built with a software tool named [GenoPro](https://www.genopro.com). It generally serves our purposes well, yet it also has its limitations.

## Names and Statistics

So far we have managed to record **528 photos**, **323 individuals** (171 males and 152 females). There are about **100 families** with around **50 family names**.

Please note that I have used the official name whenever it was known to me. Otherwise, I have used the name as it sounds or is written in Hebrew. Throughout the years, people localized their family names (e.g. Klein–Klain–Clyne, or Aharon–Aaron–Aron–Aharoni–Aroni). Please write to me about exactly how you use your name.

---

*Best regards, Yossi Gal — November 23, 2007*
"""


def write_landing_pages(
    source_dir: Path,
    secondary_dir: Optional[Path],
    vault_path: Path,
) -> None:
    """Write the two original-site landing pages to the vault root, copying their images."""
    pics_dir = vault_path / "attachments" / "pictures"
    pics_dir.mkdir(parents=True, exist_ok=True)

    # Copy epatan landing page images (Image3.gif = family tree, Image4.gif = portrait)
    epatan_images = {
        "Image3.gif": "epatan-landing-tree.gif",
        "Image4.gif": "epatan-landing-portrait.gif",
    }
    for src_name, dst_name in epatan_images.items():
        src = source_dir / src_name
        if src.exists():
            shutil.copy2(src, pics_dir / dst_name)

    (vault_path / "Elie-Patan-Family-Website.md").write_text(
        _EPATAN_LANDING, encoding="utf-8"
    )
    (vault_path / "Yossi-Gal-Family-Website.md").write_text(
        _YGTREE_LANDING, encoding="utf-8"
    )
    print("  → wrote 2 landing pages")


# Maps epatan ind_id → Document slugs to add as "See also" links in their biography.
# Used for documents not linked from any person page in the source HTML.
_EXTRA_DOC_LINKS: Dict[str, List[str]] = {
    "ind00001": ["attachments/docs/hebrew-memories"],  # Elie Patan → Hebrew memories (in Hebrew)
}


def _linked_doc_slug(stem: str) -> str:
    """'Resume concernant ma nonna Marietta' → 'Resume-concernant-ma-nonna-Marietta'"""
    return re.sub(r'\s+', '-', stem.strip())


def write_linked_documents(source_dir: Path, vault_path: Path) -> int:
    """Parse HTML linked files, create Documents/ notes, copy images. Returns note count."""
    try:
        from bs4 import BeautifulSoup
    except ImportError:
        print("  WARNING: beautifulsoup4 not available, skipping linked documents")
        return 0

    linked_dir = source_dir / "HTML linked files"
    if not linked_dir.exists():
        return 0

    docs_dir = vault_path / "attachments" / "docs"
    docs_dir.mkdir(parents=True, exist_ok=True)
    pic_dir = vault_path / "attachments" / "pictures"
    count = 0

    for htm in sorted(linked_dir.glob("*.htm")):
        # Detect encoding from meta charset
        raw = htm.read_bytes()
        encoding = "utf-8"
        m = re.search(rb'charset[=:]\s*(["\']?)([^"\'>\s]+)\1', raw, re.IGNORECASE)
        if m:
            enc_hint = m.group(2).decode("ascii", errors="replace").strip()
            if enc_hint.lower() in ("windows-1255", "iso-8859-8", "cp1255"):
                encoding = "windows-1255"

        soup = BeautifulSoup(raw.decode(encoding, errors="replace"), "html.parser")
        for tag in soup(["script", "style"]):
            tag.decompose()

        slug = _linked_doc_slug(htm.stem)
        img_prefix = slug.lower()[:20].rstrip("-")
        img_subdir = linked_dir / f"{htm.stem}_files"

        parts: List[str] = []
        body = soup.find("body") or soup
        for tag in body.descendants:
            if not hasattr(tag, "name"):
                continue
            if tag.name == "img":
                src = tag.get("src", "")
                if not src or "image001" in src or src.lower().endswith(".gif"):
                    continue
                src_path = linked_dir / unquote(src)
                if not src_path.exists():
                    src_path = img_subdir / Path(unquote(src)).name
                if src_path.exists():
                    dest_name = f"{img_prefix}_{src_path.name}"
                    if not (pic_dir / dest_name).exists():
                        shutil.copy2(src_path, pic_dir / dest_name)
                    parts.append(f"![[attachments/pictures/{dest_name}]]")
            elif tag.name in ("h1", "h2", "h3"):
                text = re.sub(r'\s+', ' ', tag.get_text(' ', strip=True)).replace('\u00a0', ' ')
                if text:
                    parts.append(f"## {text}")
            elif tag.name == "p":
                text = re.sub(r'\s+', ' ', tag.get_text(' ', strip=True)).replace('\u00a0', ' ')
                if text:
                    parts.append(text)

        # Deduplicate consecutive identical entries
        deduped: List[str] = []
        for p in parts:
            if not deduped or p != deduped[-1]:
                deduped.append(p)

        body_text = "\n\n".join(deduped)
        note = f"---\ntitle: {htm.stem}\ntags: [document]\n---\n\n{body_text}\n"
        (docs_dir / f"{slug}.md").write_text(note, encoding="utf-8")
        count += 1

    return count


def run(
    source_dir: Path,
    vault_path: Path,
    secondary_dir: Optional[Path] = None,
    config_path: Optional[Path] = None,
    report_path: Optional[Path] = None,
) -> None:
    errors: List[str] = []

    if secondary_dir is not None and config_path is None:
        print("ERROR: --config is required when --secondary is given")
        sys.exit(1)

    config: Optional[MergeConfig] = None
    if config_path is not None:
        try:
            config = load_merge_config(config_path)
        except ValueError as e:
            print(f"ERROR: {e}")
            sys.exit(1)

    # ── Pass 1: parse all ind*.htm ──────────────────────────────────────────
    print("Pass 1: parsing individuals...")
    person_records: Dict[str, PersonRecord] = {}
    for htm in sorted(source_dir.glob("ind*.htm")):
        try:
            record = parse_person(htm)
            person_records[record.id] = record
        except Exception as e:
            msg = f"ERROR parsing {htm.name}: {e}"
            print(f"  {msg}")
            errors.append(msg)
    print(f"  → {len(person_records)} individuals parsed")

    # ── Pass 2: parse all fam*.htm ──────────────────────────────────────────
    print("Pass 2: parsing families...")
    family_records: Dict[str, FamilyRecord] = {}
    for htm in sorted(source_dir.glob("fam*.htm")):
        try:
            record = parse_family(htm)
            family_records[record.id] = record
        except Exception as e:
            msg = f"ERROR parsing {htm.name}: {e}"
            print(f"  {msg}")
            errors.append(msg)
    print(f"  → {len(family_records)} families parsed")

    # ── Merge with secondary tree (if given) ───────────────────────────────
    if secondary_dir is not None:
        print("Merging secondary tree...")
        yg_persons: Dict[str, PersonRecord] = {}
        for htm in sorted(secondary_dir.glob("ind*.htm")):
            try:
                record = parse_person(htm)
                yg_persons[record.id] = record
            except Exception as e:
                print(f"  WARNING: skipping {htm.name}: {e}")

        yg_families: Dict[str, FamilyRecord] = {}
        for htm in sorted(secondary_dir.glob("fam*.htm")):
            try:
                record = parse_family(htm)
                yg_families[record.id] = record
            except Exception as e:
                print(f"  WARNING: skipping {htm.name}: {e}")

        try:
            merge_result = merge_trees(
                person_records, family_records, yg_persons, yg_families, config
            )
        except ValueError as e:
            print(f"ERROR: {e}")
            sys.exit(1)

        person_records = merge_result.person_records
        family_records = merge_result.family_records

        summary = format_report(merge_result, report_path)
        print(summary)

    # ── Build lookup maps (from merged or single-tree records) ──────────────
    person_name_map = build_person_filenames(list(person_records.values()))
    person_display_map = {ind_id: r.full_name for ind_id, r in person_records.items()}

    child_map: Dict[str, List[str]] = {}
    spouse_map: Dict[str, List[Tuple[str, str]]] = {}
    parent_children_map: Dict[str, List[str]] = {}

    for fam_id, record in family_records.items():
        for child_id in record.child_ids:
            child_map.setdefault(child_id, []).append(fam_id)
            if record.husband_id:
                parent_children_map.setdefault(record.husband_id, []).append(child_id)
            if record.wife_id:
                parent_children_map.setdefault(record.wife_id, []).append(child_id)
        if record.husband_id and record.wife_id:
            spouse_map.setdefault(record.husband_id, []).append(
                (fam_id, record.wife_id)
            )
            spouse_map.setdefault(record.wife_id, []).append(
                (fam_id, record.husband_id)
            )
        elif record.husband_id:
            spouse_map.setdefault(record.husband_id, []).append((fam_id, ""))
        elif record.wife_id:
            spouse_map.setdefault(record.wife_id, []).append((fam_id, ""))

    sibling_map: Dict[str, List[str]] = {}
    for ind_id in person_records:
        seen: set = set()
        siblings: List[str] = []
        for fam_id in child_map.get(ind_id, []):
            fam = family_records.get(fam_id)
            if fam:
                for sib_id in fam.child_ids:
                    if sib_id != ind_id and sib_id not in seen:
                        siblings.append(sib_id)
                        seen.add(sib_id)
        sibling_map[ind_id] = siblings

    # ── Pass 3: write notes, copy files ─────────────────────────────────────
    print("Pass 3: writing notes...")
    (vault_path / "People").mkdir(exist_ok=True)
    (vault_path / "attachments" / "pictures").mkdir(parents=True, exist_ok=True)
    (vault_path / "attachments" / "docs").mkdir(parents=True, exist_ok=True)

    # Delete iCloud conflict copies: stem ends with " <digits>" AND the original (without the
    # trailing number) also exists — so "Name 2.md" is only deleted if "Name.md" exists.
    # This avoids deleting legitimate files like "Nonna Marietta Dec 2001.doc".
    _icloud_conflict = re.compile(r'( \d+)$')
    for conflict in vault_path.rglob("*"):
        if not conflict.is_file():
            continue
        m = _icloud_conflict.search(conflict.stem)
        if m:
            original_stem = conflict.stem[: m.start()]
            original = conflict.with_name(original_stem + conflict.suffix)
            if original.exists():
                conflict.unlink()

    for ind_id, record in person_records.items():
        try:
            write_person_note_cr(
                record,
                person_name_map[ind_id],
                child_map,
                spouse_map,
                person_name_map,
                family_records,
                vault_path,
                parent_children_map,
                sibling_map,
                person_display_map,
            )
        except Exception as e:
            msg = f"ERROR writing {ind_id}: {e}"
            print(f"  {msg}")
            errors.append(msg)

    # Copy pictures/ (primary tree, then secondary — primary wins on name collision)
    dst_pics = vault_path / "attachments" / "pictures"
    pic_count = 0
    pic_dirs = [source_dir]
    if secondary_dir is not None:
        pic_dirs.append(secondary_dir)
    for pic_dir in pic_dirs:
        src_pics = pic_dir / "pictures"
        if src_pics.exists():
            for img in src_pics.iterdir():
                if img.is_file() and not (dst_pics / img.name).exists():
                    shutil.copy2(img, dst_pics / img.name)
                    pic_count += 1
    print(f"  → copied {pic_count} pictures")

    # Copy root-level .doc files (different from migrate.py which copies per-person .docx)
    doc_count = 0
    for doc in source_dir.glob("*.doc"):
        shutil.copy2(doc, vault_path / "attachments" / "docs" / doc.name)
        doc_count += 1
    if doc_count:
        print(f"  → copied {doc_count} .doc files")

    # Write Documents/ notes from HTML linked files
    doc_notes = write_linked_documents(source_dir, vault_path)
    if doc_notes:
        print(f"  → wrote {doc_notes} document notes")

    # Write original-site landing pages to vault root
    write_landing_pages(source_dir, secondary_dir, vault_path)

    # Patch person notes that have extra doc links not present in the source HTML
    people_dir = vault_path / "People"
    for ind_id, slugs in _EXTRA_DOC_LINKS.items():
        unified_id = person_records.get(ind_id, {}) and ind_id
        # Resolve through merge mapping if needed
        note_filename = person_name_map.get(ind_id)
        if not note_filename:
            continue
        note_path = people_dir / f"{note_filename}.md"
        if not note_path.exists():
            continue
        content = note_path.read_text(encoding="utf-8")
        # Only add links not already present
        links_to_add = [
            f"[[{s}]]" for s in slugs
            if s not in content
        ]
        if links_to_add:
            see_also = "**See also:** " + ", ".join(links_to_add)
            content = content.replace("## Biography\n", f"## Biography\n{see_also}\n\n", 1)
            note_path.write_text(content, encoding="utf-8")

    print(f"\nDone. {len(errors)} errors.")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Migrate GenoPro HTML → Charted Roots Obsidian vault"
    )
    parser.add_argument("source", type=Path, help="Path to GenoPro HTML export directory")
    parser.add_argument("vault", type=Path, help="Path to Charted Roots vault directory")
    parser.add_argument("--secondary", type=Path, default=None,
                        help="Path to secondary GenoPro HTML export directory to merge")
    parser.add_argument("--config", type=Path, default=None,
                        help="Path to merge_config.json (required with --secondary)")
    parser.add_argument("--report", type=Path, default=None,
                        help="Path to write merge report (optional)")
    args = parser.parse_args()

    if not args.source.exists():
        print(f"ERROR: source directory not found: {args.source}")
        sys.exit(1)
    if not args.vault.exists():
        print(f"ERROR: vault directory not found: {args.vault}")
        sys.exit(1)
    if args.secondary and not args.secondary.exists():
        print(f"ERROR: secondary directory not found: {args.secondary}")
        sys.exit(1)

    run(args.source, args.vault,
        secondary_dir=args.secondary,
        config_path=args.config,
        report_path=args.report)


if __name__ == "__main__":
    main()
