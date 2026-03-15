#!/usr/bin/env python3
"""
add_families.py — Extract family names from person notes and add family: wikilinks.

Reads each person's `name:` frontmatter, treats the first word as the given name
and remaining words as family names (stripping parenthetical content).
Creates stub notes in obsidian/Families/ and writes a report.

Usage:
    python3 scripts/add_families.py            # apply changes
    python3 scripts/add_families.py --dry-run  # preview without writing
"""

from __future__ import annotations

import re
import sys
import yaml
from pathlib import Path
from datetime import date
from collections import defaultdict
from typing import Optional

REPO_ROOT = Path(__file__).parent.parent
PEOPLE_DIR = REPO_ROOT / "obsidian" / "People"
FAMILIES_DIR = REPO_ROOT / "obsidian" / "Families"
REPORTS_DIR = REPO_ROOT / "reports"

# Regex to strip parenthetical content like (Miki), (Sandra), (Abada)
_PAREN_RE = re.compile(r'\s*\([^)]*\)')

# Single-letter initials or abbreviations (e.g. "D.", "M.", "E", "A.")
_INITIAL_RE = re.compile(r'^[A-Z]\.?$')

# Name particles that are part of compound surnames, not families themselves
_PARTICLES = {'de', 'van', 'von', 'el', 'al', 'bar', 'ben', 'bin', 'di', 'du', 'la', 'le'}

# Words verified as middle given names or nicknames, not family names.
# Reviewed against the actual person notes; each entry here was confirmed
# to be a non-first given name or nickname, not a maiden/married surname.
_GIVEN_NAMES = {
    # Western middle names
    'Aaron', 'Abraham', 'Alain', 'Ann', 'Beth', 'Claire', 'Daniel', 'David',
    'Diane', 'Edouard', 'Grant', 'Helene', 'Henry', 'Irene', 'Jay', 'Joanne',
    'John', 'Joseph', 'Leon', 'Leopold', 'Linda', 'Lisa', 'Madeleine',
    'Marcus', 'Meyer', 'Morris', 'Oliver', 'Reuben', 'Ruben', 'Theodore',
    'William',
    # Hebrew / Arabic middle names
    'Avraham', 'Ernest', 'Haim', 'Miklosh', 'Mina', 'Moshe', 'Maurice',
    'Rafi', 'Rivka', 'Saleh', 'Shmouel', 'Shoshana', 'Wolf', 'Yehoshua',
    'Yehuda', 'Yossef',
    # Nicknames (not in parentheses in the source data)
    'Bensi', 'Cesy', 'Deddy', 'Doudou', 'Ety', 'Fifi', 'Isi', 'Oni',
    'Peppo', 'Roby', 'Soussou', 'Touti', 'Zouzi',
    # Placeholder artifact
    'name',
}


def _is_family_name(word: str) -> bool:
    """Return False for initials, particles, and known given/middle names."""
    if _INITIAL_RE.match(word):
        return False
    if word.lower() in _PARTICLES:
        return False
    if word in _GIVEN_NAMES:
        return False
    return True


def extract_families(name: str) -> list[str]:
    """
    Extract family names from a person's full name.

    Rules:
    - Strip outer quotes (YAML artifact)
    - Strip parenthetical content: "Sarah (Sandra) Farkas Schwartz" -> "Sarah Farkas Schwartz"
    - First word = given name, remaining words = candidate family names
    - Filter out initials, name particles, and known given/middle names
    - Single-word names return empty list (no family to extract)
    """
    name = name.strip().strip('"')
    name = _PAREN_RE.sub('', name).strip()
    parts = name.split()
    if len(parts) < 2:
        return []
    return [p for p in parts[1:] if _is_family_name(p)]


def _parse_frontmatter(content: str) -> tuple[str, Optional[dict], str]:
    """
    Split a note into (raw_frontmatter_with_delimiters, parsed_data, body).
    Returns the raw frontmatter string so we can do targeted insertion
    without re-serializing the entire YAML (which would mangle wikilinks, quotes, etc.).
    """
    if not content.startswith('---'):
        return '', None, content
    end = content.find('\n---', 3)
    if end == -1:
        return '', None, content
    fm_str = content[4:end]  # between opening --- and closing ---
    split_at = end + 4
    try:
        data = yaml.safe_load(fm_str)
    except yaml.YAMLError:
        data = None
    raw_fm = content[:split_at]
    body = content[split_at:]
    return raw_fm, data, body


def _remove_family_from_frontmatter(raw_fm: str) -> str:
    """Remove the family: field from raw frontmatter if present."""
    existing_re = re.compile(r'^family:\n(?:  - .*\n?)*', re.MULTILINE)
    raw_fm = existing_re.sub('', raw_fm)
    raw_fm = re.sub(r'^family:\s*\n', '', raw_fm, flags=re.MULTILINE)
    return raw_fm


_FAMILIES_LINE_RE = re.compile(r'^\*\*Families:\*\*.*\n?', re.MULTILINE)


def _add_family_to_body(body: str, families: list[str]) -> str:
    """
    Insert or replace a **Families:** line in the ## Family section of the note body.
    Places it after the last **bold:** entry (Children, Siblings, etc.).
    """
    links = ', '.join(f'[[Families/{f}|{f}]]' for f in families)
    families_line = f'**Families:** {links}\n'

    # Remove existing Families: line if present
    body = _FAMILIES_LINE_RE.sub('', body)

    # Find the ## Family section and insert after the last **Key:** line
    family_section_re = re.compile(r'(## Family\n\n?)((?:\*\*[^*]+\*\*.*\n)*)')
    m = family_section_re.search(body)
    if m:
        insert_pos = m.end()
        body = body[:insert_pos] + families_line + body[insert_pos:]
    return body


def _create_family_stub(family_name: str, dry_run: bool) -> bool:
    """Create Families/<name>.md if absent. Returns True if created."""
    path = FAMILIES_DIR / f"{family_name}.md"
    if path.exists():
        return False
    if not dry_run:
        path.write_text(
            f'---\nname: {family_name}\ntype: family\n---\n',
            encoding='utf-8',
        )
    return True


def _write_report(
    notes_processed: int,
    notes_modified: int,
    notes_skipped: list[str],
    families_found: dict[str, list[str]],
    stubs_created: int,
    dry_run: bool,
) -> Path:
    REPORTS_DIR.mkdir(exist_ok=True)
    report_path = REPORTS_DIR / 'family_report.md'

    lines = [
        '# Family Assignment Report',
        '',
        f'Generated: {date.today()}{"  *(dry run — no files written)*" if dry_run else ""}',
        '',
        '## Summary',
        '',
        '| Metric | Value |',
        '|--------|-------|',
        f'| Notes processed | {notes_processed} |',
        f'| Notes with families assigned | {notes_modified} |',
        f'| Notes skipped (single-word name) | {len(notes_skipped)} |',
        f'| Unique families found | {len(families_found)} |',
        f'| Family stubs created | {stubs_created} |',
        '',
    ]

    # Families sorted by member count
    lines += [
        '## Families by size',
        '',
        '| Family | Members |',
        '|--------|---------|',
    ]
    for fam, members in sorted(families_found.items(), key=lambda x: -len(x[1])):
        lines.append(f'| {fam} | {len(members)} |')
    lines.append('')

    # Skipped notes
    if notes_skipped:
        lines += [
            '## Skipped notes (single-word name)',
            '',
        ]
        for name in sorted(notes_skipped):
            lines.append(f'- {name}')
        lines.append('')

    report_path.write_text('\n'.join(lines), encoding='utf-8')
    return report_path


def main() -> None:
    dry_run = '--dry-run' in sys.argv

    if not dry_run:
        FAMILIES_DIR.mkdir(exist_ok=True)

    notes_processed = 0
    notes_modified = 0
    notes_skipped: list[str] = []
    families_found: dict[str, list[str]] = defaultdict(list)

    for md_file in sorted(PEOPLE_DIR.glob('*.md')):
        content = md_file.read_text(encoding='utf-8')
        raw_fm, data, body = _parse_frontmatter(content)

        if not data or 'name' not in data:
            continue

        notes_processed += 1
        name = str(data['name'])
        families = extract_families(name)

        if not families:
            notes_skipped.append(name)
            continue

        notes_modified += 1
        for fam in families:
            families_found[fam].append(name)

        new_fm = _remove_family_from_frontmatter(raw_fm)
        new_body = _add_family_to_body(body, families)
        if not dry_run:
            md_file.write_text(new_fm + new_body, encoding='utf-8')

    # Create family stubs
    stubs_created = 0
    for family_name in sorted(families_found.keys()):
        if _create_family_stub(family_name, dry_run):
            stubs_created += 1

    report_path = _write_report(
        notes_processed, notes_modified, notes_skipped,
        families_found, stubs_created, dry_run,
    )

    mode = '[DRY RUN] ' if dry_run else ''
    print(f'{mode}Processed {notes_processed} notes.')
    print(f'{mode}Assigned families to {notes_modified} notes.')
    print(f'{mode}Skipped {len(notes_skipped)} single-word names.')
    print(f'{mode}Unique families: {len(families_found)}')
    print(f'{mode}Family stubs {"would be " if dry_run else ""}created: {stubs_created}')
    print(f'Report: {report_path}')


if __name__ == '__main__':
    main()
