#!/usr/bin/env python3
"""
link_places.py — Replace place names in person note bodies with Obsidian wikilinks.

Creates obsidian/Places/<Name>.md stubs for each place and writes a report to
reports/place_links_report.md.

Usage:
    python3 scripts/link_places.py            # apply changes
    python3 scripts/link_places.py --dry-run  # preview without writing
"""

import re
import sys
from pathlib import Path
from datetime import date
from collections import defaultdict

REPO_ROOT = Path(__file__).parent.parent
PEOPLE_DIR = REPO_ROOT / "obsidian" / "People"
PLACES_DIR = REPO_ROOT / "obsidian" / "Places"
REPORTS_DIR = REPO_ROOT / "reports"

# ---------------------------------------------------------------------------
# Place map: canonical name -> list of text variants to normalise away.
# All variants (including misspellings, alternate spellings, French forms)
# are replaced with [[Places/<canonical>]].
# Entries with multi-word names must come before any single-word subsets
# (handled automatically by sorting variants longest-first at build time).
# ---------------------------------------------------------------------------
PLACE_MAP: dict[str, list[str]] = {
    # Multi-word with parentheses — listed first (longest-first sort handles order)
    "Tyachiv":               ["Tjacev (Tecso) (Tacovo)", "Tyachev (Tacovo)", "Tyachev"],

    # Multi-word / compound — must be listed before single-word components
    "Port Said":             ["Port Said"],
    "Tel Aviv":              ["Tel Aviv", "Tel-Aviv"],
    "Buenos Aires":          ["Buenos Aires"],
    "New York":              ["New York"],
    "New Jersey":            ["New Jersey"],
    "Beit Zait":             ["Beit Zait", "Beit-Zait"],
    "Beit Shean":            ["Beit Shean", "Beit-Shean"],
    "Ramat Gan":             ["Ramat Gan", "Ramat-Gan", "Ramat-Fan"],
    "Bat Galim":             ["Bat Galim", "Bat-Galim"],
    "Kibbutz Gesher Haziv":  ["Kibbutz Gesher Haziv", "Kibutz Gesher Haziv"],

    # Single-word — sorted longest-first by the build step
    "Uzhgorod":      ["Uzhgorod", "Uzhorod", "Ungvar"],
    "Auschwitz":     ["Auschwitz", "Aushwitz"],
    "Nahariya":      ["Nahariya", "Naharia"],
    "Herzliya":      ["Herzliya", "Herzlyia"],
    "Baghdad":       ["Baghdad", "Bagdad", "Bagdag"],
    "Luxor":         ["Luxor", "Louxor"],
    "Assiut":        ["Assiut", "Assiout"],
    "Aleppo":        ["Aleppo", "Alep"],
    "Karmiel":       ["Karmiel", "Carmiel"],
    "Heliopolis":    ["Heliopolis"],
    "Czechoslovakia":["Czechoslovakia"],
    "Alexandria":    ["Alexandria"],
    "Palestine":     ["Palestine"],
    "Jerusalem":     ["Jerusalem"],
    "Binyamina":     ["Binyamina"],
    "Bridgewater":   ["Bridgewater"],
    "Pennsylvania":  ["Pennsylvania"],
    "California":    ["California"],
    "Australia":     ["Australia"],
    "Argentina":     ["Argentina"],
    "Melbourne":     ["Melbourne"],
    "Montreal":      ["Montreal"],
    "Budapest":      ["Budapest"],
    "Cambridge":     ["Cambridge"],
    "Mosul":         ["Mosul"],
    "Cyprus":        ["Cyprus"],
    "Haifa":         ["Haifa"],
    "Holon":         ["Holon"],
    "Nofit":         ["Nofit"],
    "Safed":         ["Safed"],
    "Timrat":        ["Timrat"],
    "Dallas":        ["Dallas"],
    "Newark":        ["Newark"],
    "Montreal":      ["Montreal"],
    "Canada":        ["Canada"],
    "Quebec":        ["Quebec"],
    "Sydney":        ["Sydney"],
    "Panama":        ["Panama"],
    "Texas":         ["Texas"],
    "London":        ["London"],
    "Hungary":       ["Hungary"],
    "Poland":        ["Poland"],
    "Romania":       ["Romania"],
    "Bulgaria":      ["Bulgaria"],
    "Turkey":        ["Turkey"],
    "Lebanon":       ["Lebanon"],
    "Syria":         ["Syria"],
    "Iraq":          ["Iraq", "Irak"],
    "Egypt":         ["Egypt", "Egypte"],
    "Italy":         ["Italy", "Italie"],
    "France":        ["France"],
    "Cairo":         ["Cairo", "Caire", "Le Caire"],
    "USA":           ["USA"],
}

# ---------------------------------------------------------------------------
# Israel: context-sensitive — only link when preceded by a preposition
# (avoids false-positives with the common surname "Israel").
# Each pattern must capture "Israel" in group 1.
# ---------------------------------------------------------------------------
ISRAEL_PATTERNS = [
    r'\bto (Israel)\b',
    r'\bin (Israel)\b',
    r'\bfrom (Israel)\b',
    r'\bfor (Israel)\b',
    r'\bof (Israel)\b',
    r'\ben (Israel)\b',       # French: en Israel
    r'\bvers (Israel)\b',     # French: vers Israel
    r"d'(Israel)\b",          # French: d'Israel
    r'\bpour (Israel)\b',     # French: pour Israel
    r'\bState of (Israel)\b',
    r'\bland of (Israel)\b',
    r'\bto the (Israel)\b',   # "to the State of Israel" — partial
]


def _build_replacer() -> tuple[re.Pattern, dict[str, str]]:
    """
    Build a compiled regex that either matches an existing [[wikilink]] (to skip)
    or matches any known place variant (to replace).

    Returns (compiled_pattern, variant_to_canonical_dict).
    """
    variant_to_canonical: dict[str, str] = {}
    all_variants: list[str] = []

    for canonical, variants in PLACE_MAP.items():
        for v in variants:
            variant_to_canonical[v] = canonical
            all_variants.append(v)

    # Longest first so "Port Said" is tried before "Said", etc.
    all_variants.sort(key=len, reverse=True)

    def _variant_pat(v: str) -> str:
        """Word-boundary that works even when variant starts/ends with non-word chars."""
        start = r'\b' if v[0].isalnum() or v[0] == '_' else r'(?<!\w)'
        end   = r'\b' if v[-1].isalnum() or v[-1] == '_' else r'(?!\w)'
        return start + re.escape(v) + end

    wikilink_pat = r'\[\[.*?\]\]'
    places_pat = '|'.join(_variant_pat(v) for v in all_variants)
    combined = f'({wikilink_pat})|({places_pat})'

    return re.compile(combined), variant_to_canonical


def _apply_place_replacements(
    text: str,
    compiled: re.Pattern,
    v2c: dict[str, str],
    log: list[tuple[str, str]],
) -> str:
    """Replace place variants in *text*, skipping existing [[wikilinks]]."""

    def repl(m: re.Match) -> str:
        if m.group(1) is not None:
            # Already a wikilink — leave untouched
            return m.group(1)
        variant = m.group(0)
        canonical = v2c[variant]
        log.append((variant, canonical))
        return f'[[Places/{canonical}]]'

    return compiled.sub(repl, text)


def _apply_israel_replacement(
    text: str,
    log: list[tuple[str, str]],
) -> str:
    """
    Replace 'Israel' only in preposition-led phrases to avoid surname false-positives.
    Skips occurrences already inside a [[wikilink]].
    """
    already_linked = re.compile(r'\[\[.*?Israel.*?\]\]')

    for pattern in ISRAEL_PATTERNS:
        def make_repl(log=log):
            def repl(m: re.Match) -> str:
                full = m.group(0)
                # Skip if Israel is already linked within this phrase
                if '[[' in full:
                    return full
                linked = full.replace('Israel', '[[Places/Israel]]', 1)
                log.append(('Israel', 'Israel'))
                return linked
            return repl
        text = re.sub(pattern, make_repl(), text)

    return text


def _split_frontmatter(content: str) -> tuple[str, str]:
    """
    Return (frontmatter_block, body).
    The frontmatter block includes both --- delimiters.
    If no frontmatter, frontmatter_block is ''.
    """
    if not content.startswith('---'):
        return '', content
    end = content.find('\n---', 3)
    if end == -1:
        return '', content
    split_at = end + 4  # include the closing ---
    return content[:split_at], content[split_at:]


def _create_place_stub(canonical: str, dry_run: bool) -> bool:
    """Create Places/<canonical>.md if absent. Returns True if created."""
    # Sanitise filename (replace / with -)
    filename = canonical.replace('/', '-') + '.md'
    path = PLACES_DIR / filename
    if path.exists():
        return False
    if not dry_run:
        path.write_text(
            f'---\nname: {canonical}\ntype: place\n---\n',
            encoding='utf-8',
        )
    return True


def _write_report(
    notes_modified: int,
    total_replacements: int,
    stubs_created: int,
    variant_counts: dict[tuple[str, str], int],
    file_logs: dict[str, list[tuple[str, str]]],
    dry_run: bool,
) -> Path:
    REPORTS_DIR.mkdir(exist_ok=True)
    report_path = REPORTS_DIR / 'place_links_report.md'

    lines = [
        f'# Place Links Report',
        f'',
        f'Generated: {date.today()}{"  *(dry run — no files written)*" if dry_run else ""}',
        f'',
        f'## Summary',
        f'',
        f'| Metric | Value |',
        f'|--------|-------|',
        f'| Notes modified | {notes_modified} |',
        f'| Total replacements | {total_replacements} |',
        f'| Place stubs created | {stubs_created} |',
        f'',
    ]

    # Variant normalizations (where text actually changed)
    normalized = {(orig, can): n for (orig, can), n in variant_counts.items() if orig != can}
    if normalized:
        lines += [
            '## Variant normalizations',
            '',
            '| Original text | → Canonical | Count |',
            '|---------------|-------------|-------|',
        ]
        for (orig, can), n in sorted(normalized.items(), key=lambda x: -x[1]):
            lines.append(f'| `{orig}` | `{can}` | {n} |')
        lines.append('')

    # All places by total count
    canonical_totals: dict[str, int] = defaultdict(int)
    for (_, can), n in variant_counts.items():
        canonical_totals[can] += n

    lines += [
        '## Places linked (by frequency)',
        '',
        '| Place | Occurrences |',
        '|-------|-------------|',
    ]
    for can, n in sorted(canonical_totals.items(), key=lambda x: -x[1]):
        lines.append(f'| [[Places/{can}]] | {n} |')
    lines.append('')

    # Per-file detail
    lines += ['## Replacements by file', '']
    for filename in sorted(file_logs):
        reps = file_logs[filename]
        lines.append(f'### {filename} ({len(reps)})')
        for orig, can in reps:
            if orig != can:
                lines.append(f'- `{orig}` → `[[Places/{can}]]`')
            else:
                lines.append(f'- `{orig}` → `[[Places/{can}]]`')
        lines.append('')

    report_path.write_text('\n'.join(lines), encoding='utf-8')
    return report_path


def main() -> None:
    dry_run = '--dry-run' in sys.argv

    compiled, v2c = _build_replacer()

    if not dry_run:
        PLACES_DIR.mkdir(exist_ok=True)

    notes_modified = 0
    total_replacements = 0
    variant_counts: dict[tuple[str, str], int] = defaultdict(int)
    file_logs: dict[str, list[tuple[str, str]]] = {}
    places_touched: set[str] = set()

    for md_file in sorted(PEOPLE_DIR.glob('*.md')):
        content = md_file.read_text(encoding='utf-8')
        frontmatter, body = _split_frontmatter(content)

        file_log: list[tuple[str, str]] = []
        new_body = _apply_place_replacements(body, compiled, v2c, file_log)
        new_body = _apply_israel_replacement(new_body, file_log)

        if file_log:
            notes_modified += 1
            total_replacements += len(file_log)
            file_logs[md_file.name] = file_log
            for orig, can in file_log:
                variant_counts[(orig, can)] += 1
                places_touched.add(can)

            if not dry_run:
                md_file.write_text(frontmatter + new_body, encoding='utf-8')

    # Create place stubs
    stubs_created = 0
    for canonical in sorted(places_touched):
        if _create_place_stub(canonical, dry_run):
            stubs_created += 1

    report_path = _write_report(
        notes_modified, total_replacements, stubs_created,
        variant_counts, file_logs, dry_run,
    )

    mode = '[DRY RUN] ' if dry_run else ''
    print(f'{mode}Modified {notes_modified} notes, {total_replacements} replacements.')
    print(f'{mode}Place stubs {"would be " if dry_run else ""}created: {stubs_created}')
    print(f'Report: {report_path}')


if __name__ == '__main__':
    main()
