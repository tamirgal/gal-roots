from pathlib import Path
from typing import Dict, List, Tuple
from urllib.parse import unquote

from .models import FamilyRecord, PersonRecord


def _yaml_str(value: str) -> str:
    """Return value as a safe YAML scalar. Double-quote if it contains special chars."""
    value = value.replace('\r\n', ' ').replace('\r', ' ').replace('\n', ' ')
    if any(c in value for c in ('"', ':', '[', ']', '{', '}', '#', '&', '*', '!')):
        escaped = value.replace('\\', '\\\\').replace('"', '\\"')
        return f'"{escaped}"'
    return value


def _research_level(record: PersonRecord) -> int:
    has_bio = bool(record.biography and record.biography.strip())
    has_date = bool(record.birth_date)
    has_portrait = bool(record.portrait_src)
    if has_bio and (has_date or has_portrait):
        return 2
    if has_date or has_portrait:
        return 1
    return 0


def _person_link(ind_id: str, person_name_map: Dict[str, str]) -> str:
    """Return quoted wikilink for a person by ind_id."""
    if ind_id and ind_id in person_name_map:
        return f'"[[People/{person_name_map[ind_id]}]]"'
    elif ind_id:
        return f'"[[People/Unknown-{ind_id}]]"'
    else:
        return '"[[People/Unknown-none]]"'


def _body_link(ind_id: str, person_name_map: Dict[str, str], person_display_map: Dict[str, str] = None) -> str:
    """Return a wikilink with display name for use in the note body."""
    filename = person_name_map.get(ind_id, f"Unknown-{ind_id}")
    display = person_display_map.get(ind_id, filename.replace("-", " ")) if person_display_map else filename.replace("-", " ")
    return f"[[People/{filename}|{display}]]"


def write_person_note_cr(
    record: PersonRecord,
    filename: str,
    child_map: Dict[str, List[str]],
    spouse_map: Dict[str, List[Tuple[str, str]]],
    person_name_map: Dict[str, str],
    family_records: Dict[str, FamilyRecord],
    vault_path: Path,
    parent_children_map: Dict[str, List[str]] = None,
    sibling_map: Dict[str, List[str]] = None,
    person_display_map: Dict[str, str] = None,
) -> None:
    """Write People/<filename>.md in Charted Roots frontmatter format."""
    people_dir = vault_path / "People"
    people_dir.mkdir(exist_ok=True)

    lines = ["---"]
    lines.append(f"cr_id: {record.id}")
    lines.append(f"name: {_yaml_str(record.full_name)}")

    # father/mother: derived from first family where this person is a child
    child_fam_ids = child_map.get(record.id, [])
    parent_fam = family_records.get(child_fam_ids[0]) if child_fam_ids else None
    if parent_fam:
        if parent_fam.husband_id:
            lines.append(f"father: {_person_link(parent_fam.husband_id, person_name_map)}")
            lines.append(f"father_id: {parent_fam.husband_id}")
        if parent_fam.wife_id:
            lines.append(f"mother: {_person_link(parent_fam.wife_id, person_name_map)}")
            lines.append(f"mother_id: {parent_fam.wife_id}")

    # spouse: one indexed entry per family (spouse1, spouse2, ...)
    spouse_entries = spouse_map.get(record.id, [])
    STATUS_MAP = {"married": "current", "divorced": "divorced", "separated": "separated", "cohabiting": "current"}
    i = 0
    for fam_id, other_id in spouse_entries:
        # Skip families where the partner is completely absent (no ID recorded)
        if not other_id and other_id not in person_name_map:
            continue
        i += 1
        fam = family_records.get(fam_id)
        raw_status = fam.marriage_status if fam else ""
        status = STATUS_MAP.get(raw_status.lower() if raw_status else "", "unknown")
        lines.append(f"spouse{i}: {_person_link(other_id, person_name_map)}")
        if other_id:
            lines.append(f"spouse{i}_id: {other_id}")
        lines.append(f"spouse{i}_marriage_status: {status}")

    # born: always quoted; omitted if empty
    if record.birth_date:
        lines.append(f'born: "{record.birth_date}"')

    # sex: omit if unknown
    if record.gender in ("male", "female"):
        lines.append(f"sex: {record.gender}")

    # media: portrait first, then album photos; preserve relative path under attachments/
    media_paths = []
    if record.portrait_src:
        media_paths.append(record.portrait_src)
    for photo in record.photos:
        media_paths.append(photo.src)
    if media_paths:
        lines.append("media:")
        for media_path in media_paths:
            bare = unquote(Path(media_path).name)
            lines.append(f'  - "[[attachments/pictures/{bare}]]"')

    # children + children_id: pre-written so Charted Roots plugin doesn't need reverse-scanning
    child_ids = (parent_children_map or {}).get(record.id, [])
    if child_ids:
        lines.append("children:")
        for child_id in child_ids:
            lines.append(f"  - {_person_link(child_id, person_name_map)}")
        lines.append("children_id:")
        for child_id in child_ids:
            lines.append(f"  - {child_id}")

    lines.append(f"research_level: {_research_level(record)}")
    lines.append("---")

    body = [""]
    if record.portrait_src:
        bare = unquote(Path(record.portrait_src).name)
        body.append(f"![[attachments/pictures/{bare}]]")
        body.append("")

    # Family section: plain text rows with bold label and wikilinks
    def _fl(ind_id: str) -> str:
        return _body_link(ind_id, person_name_map, person_display_map)

    family_lines = []
    if parent_fam:
        if parent_fam.husband_id:
            family_lines.append(f"**Father:** {_fl(parent_fam.husband_id)}")
        if parent_fam.wife_id:
            family_lines.append(f"**Mother:** {_fl(parent_fam.wife_id)}")
    spouse_links = [_fl(other_id) for _, other_id in spouse_entries if other_id]
    if spouse_links:
        family_lines.append(f"**Spouse:** {', '.join(spouse_links)}")
    sibling_ids = (sibling_map or {}).get(record.id, [])
    if sibling_ids:
        family_lines.append(f"**Siblings:** {', '.join(_fl(s) for s in sibling_ids)}")
    if child_ids:
        family_lines.append(f"**Children:** {', '.join(_fl(c) for c in child_ids)}")
    if family_lines:
        body.append("## Family")
        body.append("")
        body.extend(family_lines)
        body.append("")

    body += ["## Biography", record.biography or "", ""]

    if record.photos:
        body.append("## Photos")
        body.append("")
        for photo in record.photos:
            bare = unquote(Path(photo.src).name)
            body.append(f"![[attachments/pictures/{bare}]]")
            if photo.caption:
                body.append(f"*{photo.caption}*")
            body.append("")

    content = "\n".join(lines + body)
    (people_dir / f"{filename}.md").write_text(content, encoding="utf-8")
