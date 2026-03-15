#!/usr/bin/env python3
"""
Deduplicate pictures in the Charted Roots vault.

Strategy:
1. Hash every file in attachments/pictures/
2. Group files by MD5 — files in the same group are byte-for-byte identical
3. For each group, pick a canonical file:
     a. Prefer files already referenced in a person note (most references wins)
     b. Among ties, prefer files NOT matching the iCloud suffix pattern (` N.ext`)
     c. Among remaining ties, prefer the shortest filename
4. Dry-run: show what would be deleted / what notes would be updated
5. Execute: update note references, then delete redundant files

Usage:
    python3 -m scripts.dedup_pictures          # dry-run (safe, no changes)
    python3 -m scripts.dedup_pictures --execute # actually update + delete
"""

import argparse
import hashlib
import os
import re
import sys
from collections import defaultdict
from pathlib import Path

# ── Paths ────────────────────────────────────────────────────────────────────
VAULT = Path(__file__).resolve().parent.parent / "obsidian"
PICTURES_DIR = VAULT / "attachments" / "pictures"
PEOPLE_DIR = VAULT / "People"

# iCloud duplicate pattern: name ending with " <digits>" before the extension
_ICLOUD_RE = re.compile(r"^(.*)\s+\d+$")


def md5_file(path: Path) -> str:
    h = hashlib.md5()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def is_icloud_copy(stem: str) -> bool:
    return bool(_ICLOUD_RE.match(stem))


def find_all_picture_refs(people_dir: Path) -> dict[str, list[Path]]:
    """Return mapping: picture filename → list of note paths that reference it."""
    refs: dict[str, list[Path]] = defaultdict(list)
    pattern = re.compile(r'\[\[attachments/pictures/([^\]]+)\]\]')
    for note in people_dir.glob("*.md"):
        text = note.read_text(encoding="utf-8", errors="replace")
        for m in pattern.finditer(text):
            refs[m.group(1)].append(note)
    return refs


def select_canonical(files: list[Path], ref_counts: dict[str, int]) -> Path:
    """Choose the file to keep from a group of identical files."""
    # Sort by: (fewer refs is worse, so we sort descending by refs), then
    # iCloud copy (False sorts before True → non-iCloud preferred), then name length.
    def key(p: Path):
        refs = ref_counts.get(p.name, 0)
        icloud = is_icloud_copy(p.stem)
        return (-refs, icloud, len(p.name), p.name)

    return sorted(files, key=key)[0]


def update_note(note: Path, old_name: str, new_name: str, dry_run: bool) -> bool:
    """Replace references to old_name with new_name in a note. Returns True if changed."""
    text = note.read_text(encoding="utf-8", errors="replace")
    old_ref = f"[[attachments/pictures/{old_name}]]"
    new_ref = f"[[attachments/pictures/{new_name}]]"
    if old_ref not in text:
        return False
    new_text = text.replace(old_ref, new_ref)
    if not dry_run:
        note.write_text(new_text, encoding="utf-8")
    return True


def main():
    parser = argparse.ArgumentParser(description="Deduplicate pictures in Charted Roots vault")
    parser.add_argument("--execute", action="store_true",
                        help="Actually delete duplicates and update notes (default: dry-run)")
    args = parser.parse_args()
    dry_run = not args.execute

    if dry_run:
        print("DRY RUN — no files will be changed. Pass --execute to apply.\n")
    else:
        print("EXECUTE MODE — files will be deleted and notes updated.\n")

    # ── Step 1: Hash all pictures ──────────────────────────────────────────
    print("Hashing pictures...", flush=True)
    hash_to_files: dict[str, list[Path]] = defaultdict(list)
    all_pictures = [p for p in PICTURES_DIR.iterdir() if p.is_file() and not p.name.startswith(".")]
    for pic in sorted(all_pictures):
        h = md5_file(pic)
        hash_to_files[h].append(pic)

    total = len(all_pictures)
    dup_groups = {h: files for h, files in hash_to_files.items() if len(files) > 1}
    print(f"  {total} files, {len(dup_groups)} duplicate groups\n")

    # ── Step 2: Find note references ──────────────────────────────────────
    print("Scanning note references...", flush=True)
    refs = find_all_picture_refs(PEOPLE_DIR)
    ref_counts = {name: len(notes) for name, notes in refs.items()}
    print(f"  {sum(ref_counts.values())} picture references in {len(refs)} distinct filenames\n")

    # ── Step 3: For each duplicate group, pick canonical ──────────────────
    to_delete: list[Path] = []
    note_updates: list[tuple[Path, str, str]] = []  # (note, old_name, new_name)

    for h, files in sorted(dup_groups.items(), key=lambda kv: -len(kv[1])):
        canonical = select_canonical(files, ref_counts)
        extras = [f for f in files if f != canonical]

        for extra in extras:
            to_delete.append(extra)
            # If any note references the extra, update it to the canonical
            for note in refs.get(extra.name, []):
                note_updates.append((note, extra.name, canonical.name))

    # ── Step 4: Report ────────────────────────────────────────────────────
    print(f"{'[DRY RUN] ' if dry_run else ''}Summary:")
    print(f"  Files to delete:        {len(to_delete)}")
    print(f"  Note updates needed:    {len(note_updates)}")
    print()

    if note_updates:
        print("Note updates:")
        for note, old, new in sorted(note_updates, key=lambda x: x[0].name):
            print(f"  {note.name}: {old!r}  →  {new!r}")
        print()

    # Sample of largest groups
    print("Largest duplicate groups (showing canonical + redundant):")
    for h, files in sorted(dup_groups.items(), key=lambda kv: -len(kv[1]))[:15]:
        canonical = select_canonical(files, ref_counts)
        extras = [f for f in files if f != canonical]
        refs_note = f"({ref_counts.get(canonical.name, 0)} refs)" if ref_counts.get(canonical.name) else "(unreferenced)"
        print(f"  KEEP  {canonical.name} {refs_note}")
        for e in extras[:5]:
            erefs = f"({ref_counts.get(e.name, 0)} refs)" if ref_counts.get(e.name) else ""
            print(f"  DEL   {e.name} {erefs}")
        if len(extras) > 5:
            print(f"        ... and {len(extras) - 5} more")
        print()

    # ── Step 5: Execute ───────────────────────────────────────────────────
    if dry_run:
        print("Re-run with --execute to apply these changes.")
        return

    # Update notes first (safer: if delete fails, notes still consistent)
    updated_notes: set[Path] = set()
    for note, old, new in note_updates:
        changed = update_note(note, old, new, dry_run=False)
        if changed:
            updated_notes.add(note)

    print(f"Updated {len(updated_notes)} notes.")

    # Delete redundant files
    deleted = 0
    errors = 0
    for path in to_delete:
        try:
            path.unlink()
            deleted += 1
        except OSError as e:
            print(f"  ERROR deleting {path.name}: {e}", file=sys.stderr)
            errors += 1

    print(f"Deleted {deleted} files ({errors} errors).")
    print("Done.")


if __name__ == "__main__":
    main()
