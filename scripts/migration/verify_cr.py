# scripts/migration/verify_cr.py
"""
Verify a Charted Roots vault against GenoPro HTML source data.

Usage:
    python3 -m scripts.migration.verify_cr <source_dir> <vault_path>

Exit code 0 = clean vault, 1 = issues found.
"""
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Tuple
from urllib.parse import unquote

import yaml

from .models import FamilyRecord, PersonRecord

STATUS_MAP = {
    "married": "current",
    "divorced": "divorced",
    "separated": "separated",
    "cohabiting": "current",
}

MIGRATION_OWNED_FIELDS = {"cr_id", "father", "father_id", "mother", "mother_id", "born", "sex", "research_level", "media", "children", "children_id"}
_SPOUSE_RE = re.compile(r"^spouse\d+$")
_SPOUSE_STATUS_RE = re.compile(r"^spouse\d+_marriage_status$")
_SPOUSE_ID_RE = re.compile(r"^spouse\d+_id$")


@dataclass
class FieldIssue:
    field: str    # e.g. "father", "spouse1_marriage_status", "FILE"
    expected: str # e.g. "[[People/X]]" or "ABSENT" or "exists"
    got: str      # e.g. "MISSING" or actual wrong value


@dataclass
class PersonIssue:
    ind_id: str
    filename: str   # filename stem, e.g. "Joseph-Yossi-Gal"
    fields: List[FieldIssue]


@dataclass
class VerificationReport:
    total: int
    issues: List[PersonIssue]

    @property
    def passed(self) -> int:
        return self.total - len(self.issues)


def _is_migration_owned(key: str) -> bool:
    return (key in MIGRATION_OWNED_FIELDS
            or bool(_SPOUSE_RE.match(key))
            or bool(_SPOUSE_STATUS_RE.match(key))
            or bool(_SPOUSE_ID_RE.match(key)))


def _person_link(ind_id: str, person_name_map: Dict[str, str]) -> str:
    """Return bare wikilink string (as yaml.safe_load would return it — no surrounding quotes)."""
    if ind_id and ind_id in person_name_map:
        return f"[[People/{person_name_map[ind_id]}]]"
    elif ind_id:
        return f"[[People/Unknown-{ind_id}]]"
    else:
        return "[[People/Unknown-none]]"


def _research_level(record: PersonRecord) -> int:
    has_bio = bool(record.biography and record.biography.strip())
    has_date = bool(record.birth_date)
    has_portrait = bool(record.portrait_src)
    if has_bio and (has_date or has_portrait):
        return 2
    if has_date or has_portrait:
        return 1
    return 0


def _expected_fields(
    record: PersonRecord,
    filename: str,
    child_map: Dict[str, List[str]],
    spouse_map: Dict[str, List[Tuple[str, str]]],
    person_name_map: Dict[str, str],
    family_records: Dict[str, FamilyRecord],
    parent_children_map: Dict[str, List[str]] = None,
) -> Dict[str, Any]:
    """Return {field_name: expected_value} for a person.

    Fields that should be absent are NOT included. Values are Python objects
    (strings, ints, lists) as yaml.safe_load would return them — not YAML-quoted strings.
    """
    expected: Dict[str, Any] = {}
    expected["cr_id"] = record.id

    # father / mother: from first family where this person is a child
    child_fam_ids = child_map.get(record.id, [])
    if child_fam_ids:
        fam = family_records.get(child_fam_ids[0])
        if fam:
            if fam.husband_id:
                expected["father"] = _person_link(fam.husband_id, person_name_map)
                expected["father_id"] = fam.husband_id
            if fam.wife_id:
                expected["mother"] = _person_link(fam.wife_id, person_name_map)
                expected["mother_id"] = fam.wife_id

    # spouses: one indexed entry per family
    spouse_entries = spouse_map.get(record.id, [])
    for i, (fam_id, other_id) in enumerate(spouse_entries, start=1):
        fam = family_records.get(fam_id)
        raw_status = fam.marriage_status if fam else ""
        status = STATUS_MAP.get(raw_status.lower() if raw_status else "", "unknown")
        expected[f"spouse{i}"] = _person_link(other_id, person_name_map)
        if other_id:
            expected[f"spouse{i}_id"] = other_id
        expected[f"spouse{i}_marriage_status"] = status

    # born: always a string; omit if empty
    if record.birth_date:
        expected["born"] = record.birth_date

    # sex: omit if unknown
    if record.gender in ("male", "female"):
        expected["sex"] = record.gender

    # media: portrait first, then album photos; URL-decoded bare filenames
    media_paths = []
    if record.portrait_src:
        media_paths.append(record.portrait_src)
    for photo in record.photos:
        media_paths.append(photo.src)
    if media_paths:
        expected["media"] = [
            f"[[attachments/pictures/{unquote(Path(p).name)}]]"
            for p in media_paths
        ]

    # children + children_id: list of child wikilinks and cr_ids
    child_ids = (parent_children_map or {}).get(record.id, [])
    if child_ids:
        expected["children"] = [_person_link(cid, person_name_map) for cid in child_ids]
        expected["children_id"] = child_ids

    expected["research_level"] = _research_level(record)
    return expected


def _check_person(
    record: PersonRecord,
    filename: str,
    child_map: Dict[str, List[str]],
    spouse_map: Dict[str, List[Tuple[str, str]]],
    person_name_map: Dict[str, str],
    family_records: Dict[str, FamilyRecord],
    vault_path: Path,
    parent_children_map: Dict[str, List[str]] = None,
) -> List[FieldIssue]:
    """Check one person's vault note. Returns list of FieldIssue (empty = all correct)."""
    expected = _expected_fields(record, filename, child_map, spouse_map, person_name_map, family_records, parent_children_map)
    note_path = vault_path / "People" / f"{filename}.md"

    if not note_path.exists():
        return [FieldIssue(field="FILE", expected="exists", got="MISSING")]

    text = note_path.read_text(encoding="utf-8")
    fm: Dict[str, Any] = yaml.safe_load(text.split("---", 2)[1]) or {}

    issues: List[FieldIssue] = []

    # Check every expected field
    for key, exp_val in expected.items():
        actual = fm.get(key)
        if key == "born" and actual is not None and not isinstance(actual, str):
            issues.append(FieldIssue(
                field=key,
                expected=str(exp_val),
                got=f"type:{type(actual).__name__}:{actual}",
            ))
        elif actual != exp_val:
            issues.append(FieldIssue(
                field=key,
                expected=str(exp_val),
                got="MISSING" if actual is None else str(actual),
            ))

    # Check for unexpected migration-owned fields
    for key in fm:
        if key not in expected and _is_migration_owned(key):
            issues.append(FieldIssue(field=key, expected="ABSENT", got=str(fm[key])))

    return issues


def verify(source_dir: Path, vault_path: Path) -> VerificationReport:
    """Parse source data, check every vault note, return structured report.

    No stdout output. Raises on unreadable source files.
    """
    from .name_utils import build_person_filenames
    from .parsers import parse_family, parse_person

    # Pass 1: parse all ind*.htm
    person_records: Dict[str, PersonRecord] = {}
    for htm in sorted(source_dir.glob("ind*.htm")):
        record = parse_person(htm)
        person_records[record.id] = record

    person_name_map = build_person_filenames(list(person_records.values()))

    # Pass 2: parse all fam*.htm — build child_map and spouse_map
    family_records: Dict[str, FamilyRecord] = {}
    child_map: Dict[str, List[str]] = {}
    spouse_map: Dict[str, List[Tuple[str, str]]] = {}
    parent_children_map: Dict[str, List[str]] = {}

    for htm in sorted(source_dir.glob("fam*.htm")):
        record = parse_family(htm)
        family_records[record.id] = record
        for child_id in record.child_ids:
            child_map.setdefault(child_id, []).append(record.id)
            if record.husband_id:
                parent_children_map.setdefault(record.husband_id, []).append(child_id)
            if record.wife_id:
                parent_children_map.setdefault(record.wife_id, []).append(child_id)
        if record.husband_id and record.wife_id:
            spouse_map.setdefault(record.husband_id, []).append((record.id, record.wife_id))
            spouse_map.setdefault(record.wife_id, []).append((record.id, record.husband_id))
        elif record.husband_id:
            spouse_map.setdefault(record.husband_id, []).append((record.id, ""))
        elif record.wife_id:
            spouse_map.setdefault(record.wife_id, []).append((record.id, ""))

    # Pass 3: check each person note
    person_issues: List[PersonIssue] = []
    for ind_id, record in person_records.items():
        filename = person_name_map[ind_id]
        field_issues = _check_person(
            record, filename, child_map, spouse_map, person_name_map, family_records, vault_path,
            parent_children_map,
        )
        if field_issues:
            person_issues.append(PersonIssue(ind_id=ind_id, filename=filename, fields=field_issues))

    return VerificationReport(total=len(person_records), issues=person_issues)


def print_report(report: VerificationReport, source_dir: Path) -> None:
    """Print human-readable report to stdout."""
    print(f"Verifying {report.total} notes against {source_dir}...")
    print()
    if not report.issues:
        print(f"✅ {report.total} / {report.total} notes fully correct")
        return

    print(f"✅ {report.passed} / {report.total} notes fully correct")
    print(f"❌ {len(report.issues)} notes have issues")
    print()
    print("ISSUES:")
    for pi in sorted(report.issues, key=lambda x: x.ind_id):
        print(f"  {pi.ind_id}  {pi.filename}.md")
        for fi in pi.fields:
            print(f"    {fi.field}:  expected {fi.expected!r}  got: {fi.got}")

    counts = {
        "missing/wrong father": 0,
        "missing/wrong mother": 0,
        "missing/wrong spouse": 0,
        "missing/wrong spouse_status": 0,
        "missing/wrong born": 0,
        "missing/wrong sex": 0,
        "missing/wrong research_level": 0,
        "missing/wrong media": 0,
        "missing/wrong children_id": 0,
        "note file missing": 0,
        "other": 0,
    }
    for pi in report.issues:
        for fi in pi.fields:
            if fi.field == "father":
                counts["missing/wrong father"] += 1
            elif fi.field == "mother":
                counts["missing/wrong mother"] += 1
            elif _SPOUSE_RE.match(fi.field):
                counts["missing/wrong spouse"] += 1
            elif _SPOUSE_STATUS_RE.match(fi.field):
                counts["missing/wrong spouse_status"] += 1
            elif fi.field == "born":
                counts["missing/wrong born"] += 1
            elif fi.field == "sex":
                counts["missing/wrong sex"] += 1
            elif fi.field == "research_level":
                counts["missing/wrong research_level"] += 1
            elif fi.field == "media":
                counts["missing/wrong media"] += 1
            elif fi.field == "children_id":
                counts["missing/wrong children_id"] += 1
            elif fi.field == "FILE":
                counts["note file missing"] += 1
            else:
                counts["other"] += 1

    print()
    print("SUMMARY BY ISSUE TYPE:")
    for label, count in counts.items():
        if label != "other":
            print(f"  {label}:  {count} notes")
    if counts["other"]:
        print(f"  other:  {counts['other']} notes")


def main() -> None:
    """CLI entry point."""
    import argparse
    parser = argparse.ArgumentParser(description="Verify Charted Roots vault against GenoPro HTML source")
    parser.add_argument("source", type=Path, help="Path to GenoPro HTML export directory")
    parser.add_argument("vault", type=Path, help="Path to Charted Roots vault directory")
    args = parser.parse_args()

    if not args.source.exists():
        print(f"ERROR: source directory not found: {args.source}")
        sys.exit(1)
    if not args.vault.exists():
        print(f"ERROR: vault directory not found: {args.vault}")
        sys.exit(1)

    report = verify(args.source, args.vault)
    print_report(report, args.source)
    sys.exit(0 if not report.issues else 1)


if __name__ == "__main__":
    main()
