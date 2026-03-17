#!/usr/bin/env python3
"""Add a Details section to each person note before the Family section.

Details section contains:
  - Hebrew Name (first alias if exists)
  - Birthday (from frontmatter born field)
  - Born in (empty for now)
  - Families (moved from Family section)
"""
from __future__ import annotations

import re
from pathlib import Path


PEOPLE_DIR = Path("obsidian/People")


def extract_first_alias(frontmatter: str) -> str:
    m = re.search(r'^aliases:\s*\n\s*-\s*"?([^"\n]+)"?', frontmatter, re.MULTILINE)
    return m.group(1).strip() if m else ""


def extract_born(frontmatter: str) -> str:
    m = re.search(r'^born:\s*"?([^"\n]+)"?', frontmatter, re.MULTILINE)
    return m.group(1).strip() if m else ""


def process_note(path: Path) -> bool:
    text = path.read_text(encoding="utf-8")

    if "## Details" in text:
        return False

    fm_match = re.match(r"^---\n(.*?\n)---\n", text, re.DOTALL)
    if not fm_match:
        return False

    frontmatter = fm_match.group(1)
    hebrew_name = extract_first_alias(frontmatter)
    birthday = extract_born(frontmatter)

    families_line = ""
    family_section_pattern = re.compile(
        r"(\*\*Families:\*\*[^\n]*\n)", re.MULTILINE
    )
    fm_match_in_body = family_section_pattern.search(text)
    if fm_match_in_body:
        families_line = fm_match_in_body.group(1).strip()
        text = text[: fm_match_in_body.start()] + text[fm_match_in_body.end() :]

    details = "## Details\n\n"
    details += f"**Hebrew Name:** {hebrew_name}\n"
    details += f"**Birthday:** {birthday}\n"
    details += "**Born in:**\n"
    if families_line:
        details += f"{families_line}\n"
    details += "\n"

    text = text.replace("## Family\n", details + "## Family\n")

    path.write_text(text, encoding="utf-8")
    return True


def main():
    count = 0
    for md in sorted(PEOPLE_DIR.glob("*.md")):
        if process_note(md):
            count += 1
    print(f"Updated {count} notes")


if __name__ == "__main__":
    main()
