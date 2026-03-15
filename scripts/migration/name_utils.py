import re
from typing import Dict, List

from .models import FamilyRecord, PersonRecord


def full_name_to_slug(name: str) -> str:
    """Convert 'Elie  Patan' to 'Elie-Patan'. Strips non-word chars."""
    name = re.sub(r'\s+', ' ', name.strip())
    name = re.sub(r"[^\w\s\-]", "", name)
    return re.sub(r'\s+', '-', name)


def _is_unknown(name: str) -> bool:
    stripped = name.strip("?").strip()
    return not stripped or stripped.lower() == "unknown"


def build_person_filenames(records: List[PersonRecord]) -> Dict[str, str]:
    """Returns {ind_id: filename_stem}. Resolves all collisions during this call."""
    # First pass: compute raw slug per record
    raw: Dict[str, str] = {}
    for r in records:
        if _is_unknown(r.full_name):
            raw[r.id] = f"Unknown-{r.id}"
        else:
            raw[r.id] = full_name_to_slug(r.full_name)

    # Count raw slug occurrences
    counts: Dict[str, int] = {}
    for slug in raw.values():
        counts[slug] = counts.get(slug, 0) + 1

    # Apply tiebreakers for duplicates.
    # People without a birth date get the -id suffix; people with a birth date keep
    # the plain slug (they are the more identifiable record). If all colliders have
    # birth dates, use the year to disambiguate.
    tiebroken: Dict[str, str] = {}
    # Group colliders by slug so we can decide per-group
    from collections import defaultdict
    slug_groups: Dict[str, List] = defaultdict(list)
    for r in records:
        if counts[raw[r.id]] > 1:
            slug_groups[raw[r.id]].append(r)

    # For each collision group: if exactly one member has a birth date, give them
    # the plain slug and suffix the rest with their id.
    plain_ids: set = set()
    for slug, group in slug_groups.items():
        dated = [r for r in group if r.birth_date]
        if len(dated) == 1:
            plain_ids.add(dated[0].id)

    for r in records:
        slug = raw[r.id]
        if counts[slug] > 1:
            if r.id in plain_ids:
                pass  # keep plain slug
            elif r.birth_date:
                slug = f"{slug}-{r.birth_date[:4]}"
            else:
                slug = f"{slug}-{r.id}"
        tiebroken[r.id] = slug

    # Handle any remaining post-tiebreak collisions (e.g. same name + same birth year).
    # Count how many records share each post-tiebreak slug.
    tb_counts: Dict[str, int] = {}
    for slug in tiebroken.values():
        tb_counts[slug] = tb_counts.get(slug, 0) + 1

    result: Dict[str, str] = {}
    for r in records:
        slug = tiebroken[r.id]
        if tb_counts[slug] > 1:
            result[r.id] = f"{slug}-{r.id}"
        else:
            result[r.id] = slug

    return result


def build_family_filenames(
    records: List[FamilyRecord], person_name_map: Dict[str, str]
) -> Dict[str, str]:
    """Returns {fam_id: filename_stem}. Resolves collisions."""
    collision_counts: Dict[str, int] = {}
    result: Dict[str, str] = {}

    for r in records:
        h = person_name_map.get(r.husband_id, f"Unknown-{r.husband_id}")
        w = person_name_map.get(r.wife_id, f"Unknown-{r.wife_id}")
        base = f"{h}--{w}"

        if base in collision_counts:
            collision_counts[base] += 1
            result[r.id] = f"{base}-{collision_counts[base] + 1}"
        else:
            collision_counts[base] = 0
            result[r.id] = base

    return result
