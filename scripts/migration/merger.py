import dataclasses
import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from .models import FamilyRecord, PersonRecord


@dataclass
class MergeConfig:
    source_overrides: List[str]
    match_overrides: List[Dict[str, str]]
    forced_non_matches: List[Dict[str, str]]


def load_merge_config(path: Path) -> MergeConfig:
    """Load and validate merge_config.json. Raises ValueError on invalid config."""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        raise ValueError(f"Cannot read config: {e}")
    if data.get("version") != 1:
        raise ValueError(f"Config version must be 1, got: {data.get('version')!r}")
    return MergeConfig(
        source_overrides=data.get("source_overrides", []),
        match_overrides=data.get("match_overrides", []),
        forced_non_matches=data.get("forced_non_matches", []),
    )


def normalize_name(name: str) -> str:
    """Strip parenthetical nicknames, lowercase, collapse whitespace. Preserve hyphens."""
    result = re.sub(r'\([^)]*\)', '', name)
    result = result.lower()
    result = re.sub(r'\s+', ' ', result).strip()
    return result


def extract_birth_year(birth_date: str) -> Optional[str]:
    """Return 4-digit year string, or None for approximate/missing dates."""
    if not birth_date:
        return None
    if re.search(r'\b(circa|before|after|c\.)\b', birth_date, re.IGNORECASE):
        return None
    m = re.search(r'\b(\d{4})\b', birth_date)
    return m.group(1) if m else None


@dataclass
class MatchResult:
    # (yg_id, ep_id) - includes match_override pairs
    confident: List[Tuple[str, str]] = field(default_factory=list)
    # (yg_id, [ep_candidate_ids], reason)
    uncertain: List[Tuple[str, List[str], str]] = field(default_factory=list)
    # yg_ids with no match
    ygtree_unique: List[str] = field(default_factory=list)


def match_people(
    yg_records: Dict[str, PersonRecord],
    ep_records: Dict[str, PersonRecord],
    config: MergeConfig,
) -> MatchResult:
    result = MatchResult()

    # Build lookup sets from config
    forced_non = {
        (d["ygtree"], d["epatan"]) for d in config.forced_non_matches
    }
    manual_matches = {
        d["ygtree"]: d["epatan"] for d in config.match_overrides
    }

    # Build epatan index: normalized_name -> [ep_id]
    ep_by_name: Dict[str, List[str]] = {}
    for ep_id, ep_rec in ep_records.items():
        key = normalize_name(ep_rec.full_name)
        ep_by_name.setdefault(key, []).append(ep_id)

    # Build epatan index: (normalized_name, year) -> [ep_id]
    ep_by_name_year: Dict[Tuple[str, str], List[str]] = {}
    for ep_id, ep_rec in ep_records.items():
        year = extract_birth_year(ep_rec.birth_date)
        if year:
            key = (normalize_name(ep_rec.full_name), year)
            ep_by_name_year.setdefault(key, []).append(ep_id)

    # Already-matched ep_ids (to avoid double-matching)
    matched_ep: set = set(manual_matches.values())

    # Apply manual match_overrides first
    for yg_id, ep_id in manual_matches.items():
        if yg_id not in yg_records:
            print(f"  WARNING: match_override ygtree ID not found: {yg_id!r}")
            continue
        if ep_id not in ep_records:
            print(f"  WARNING: match_override epatan ID not found: {ep_id!r}")
            continue
        result.confident.append((yg_id, ep_id))

    # Match remaining yg people
    for yg_id, yg_rec in yg_records.items():
        if yg_id in manual_matches:
            continue  # already handled

        yg_name = normalize_name(yg_rec.full_name)
        yg_year = extract_birth_year(yg_rec.birth_date)

        # Tier 1: name + year both match
        if yg_year:
            candidates = [
                ep_id for ep_id in ep_by_name_year.get((yg_name, yg_year), [])
                if (yg_id, ep_id) not in forced_non and ep_id not in matched_ep
            ]
            if len(candidates) == 1:
                result.confident.append((yg_id, candidates[0]))
                matched_ep.add(candidates[0])
                continue
            elif len(candidates) > 1:
                result.uncertain.append((yg_id, candidates, "multiple Tier 1 candidates"))
                continue

        # Tier 2a: year matches but name differs
        if yg_year:
            ep_year_matches = [
                ep_id for ep_id, ep_rec in ep_records.items()
                if extract_birth_year(ep_rec.birth_date) == yg_year
                and normalize_name(ep_rec.full_name) != yg_name
                and (yg_id, ep_id) not in forced_non
                and ep_id not in matched_ep
            ]
            if ep_year_matches:
                result.uncertain.append((yg_id, ep_year_matches, "same birth year, different name"))
                continue

        # Tier 2b: name matches but no birth year on either side
        ep_name_matches = [
            ep_id for ep_id in ep_by_name.get(yg_name, [])
            if (yg_id, ep_id) not in forced_non
            and ep_id not in matched_ep
            and not extract_birth_year(ep_records[ep_id].birth_date)
            and not yg_year
        ]
        if ep_name_matches:
            result.uncertain.append((yg_id, ep_name_matches, "same name, no birth year"))
            continue

        # Tier 3: no match
        result.ygtree_unique.append(yg_id)

    return result


def assign_unified_ids(
    yg_records: Dict[str, PersonRecord],
    match_result: MatchResult,
) -> Dict[str, str]:
    """Build yg_id → unified_id mapping.
    Matched: yg_id → ep_id. Unmatched (Tier 2 uncertain + Tier 3 unique): yg_id → ind10001+.
    Uncertain people are treated as ygtree-unique to avoid broken links from skipped IDs.
    """
    mapping: Dict[str, str] = {}
    for yg_id, ep_id in match_result.confident:
        mapping[yg_id] = ep_id

    uncertain_yg_ids = {yg_id for yg_id, _, _ in match_result.uncertain}

    counter = 10001
    for yg_id in yg_records:
        if yg_id in match_result.ygtree_unique or yg_id in uncertain_yg_ids:
            mapping[yg_id] = f"ind{counter:05d}"
            counter += 1

    return mapping


def resolve_source_override_ids(
    yg_records: Dict[str, PersonRecord],
    source_overrides: List[str],
) -> set:
    """Return set of yg_ids for source_override names. Raises ValueError on 0 or 2+ matches."""
    override_ids = set()
    for name in source_overrides:
        matches = [yg_id for yg_id, r in yg_records.items() if r.full_name == name]
        if len(matches) == 0:
            raise ValueError(f"No ygtree person found for source_override: {name!r}")
        if len(matches) > 1:
            raise ValueError(f"Multiple ygtree people match source_override: {name!r}")
        override_ids.add(matches[0])
    return override_ids


def merge_person_records(
    ep_records: Dict[str, PersonRecord],
    yg_records: Dict[str, PersonRecord],
    yg_to_unified: Dict[str, str],
    override_ids: set,
) -> Dict[str, PersonRecord]:
    """Produce merged person records keyed by unified ID."""
    merged = dict(ep_records)

    for yg_id, unified_id in yg_to_unified.items():
        yg_rec = yg_records[yg_id]
        if unified_id in ep_records:
            if yg_id in override_ids:
                # ygtree fields win; keep unified_id
                merged[unified_id] = dataclasses.replace(yg_rec, id=unified_id)
            # else: ep fields already in merged, nothing to do
        else:
            # ygtree-unique: add with translated id
            merged[unified_id] = dataclasses.replace(yg_rec, id=unified_id)

    return merged


@dataclass
class MergeResult:
    person_records: Dict[str, PersonRecord]
    family_records: Dict[str, FamilyRecord]
    match_result: MatchResult
    yg_to_unified: Dict[str, str]
    conflicts: List[str]
    yg_records_ref: Dict[str, PersonRecord]
    source_override_ids: set
    match_override_yg_ids: set


def merge_trees(
    ep_persons: Dict[str, PersonRecord],
    ep_families: Dict[str, FamilyRecord],
    yg_persons: Dict[str, PersonRecord],
    yg_families: Dict[str, FamilyRecord],
    config: MergeConfig,
) -> "MergeResult":
    """Run the full merge pipeline. Raises ValueError if config is invalid."""
    override_ids = resolve_source_override_ids(yg_persons, config.source_overrides)
    match_result = match_people(yg_persons, ep_persons, config)
    yg_to_unified = assign_unified_ids(yg_persons, match_result)
    persons = merge_person_records(ep_persons, yg_persons, yg_to_unified, override_ids)
    families, conflicts = merge_family_records(ep_families, yg_families, yg_to_unified)
    manual_yg_ids = {d["ygtree"] for d in config.match_overrides}
    return MergeResult(
        person_records=persons,
        family_records=families,
        match_result=match_result,
        yg_to_unified=yg_to_unified,
        conflicts=conflicts,
        yg_records_ref=yg_persons,
        source_override_ids=override_ids,
        match_override_yg_ids=manual_yg_ids,
    )


def format_report(result: "MergeResult", report_path: Optional[Path]) -> str:
    """Write the merge report to report_path (if given) and return a terminal summary string."""
    yg = result.yg_records_ref

    lines = ["# Merge Report", ""]

    lines.append("## Confident matches")
    lines.append("")
    for yg_id, ep_id in result.match_result.confident:
        yg_rec = yg.get(yg_id)
        name = yg_rec.full_name if yg_rec else yg_id
        year = extract_birth_year(yg_rec.birth_date if yg_rec else "") or ""
        born_str = f"   born {year}" if year else ""
        lines.append(f"v {name:<30} yg:{yg_id} -> ep:{ep_id}{born_str}")
    lines.append("")

    lines.append("## Uncertain matches (action required)")
    lines.append("")
    for yg_id, candidates, reason in result.match_result.uncertain:
        yg_rec = yg.get(yg_id)
        name = yg_rec.full_name if yg_rec else yg_id
        year = extract_birth_year(yg_rec.birth_date if yg_rec else "") or "?"
        lines.append(f"? yg:{yg_id} \"{name}\" born {year}")
        for ep_id in candidates:
            ep_rec = result.person_records.get(ep_id)
            ep_name = ep_rec.full_name if ep_rec else ep_id
            ep_year = extract_birth_year(ep_rec.birth_date if ep_rec else "") or "?"
            lines.append(f"  ep:{ep_id} \"{ep_name}\" born {ep_year}")
        lines.append(f"  -> {reason}. Add to match_overrides or forced_non_matches.")
        lines.append("")

    lines.append("## ygtree-unique people added")
    lines.append("")
    for yg_id in result.match_result.ygtree_unique:
        unified_id = result.yg_to_unified.get(yg_id, "?")
        yg_rec = yg.get(yg_id)
        name = yg_rec.full_name if yg_rec else yg_id
        year = extract_birth_year(yg_rec.birth_date if yg_rec else "") or ""
        born_str = f"   born {year}" if year else ""
        lines.append(f"+ {name:<30} unified:{unified_id}{born_str}")
    lines.append("")

    lines.append("## Parent link conflicts (epatan parent kept)")
    lines.append("")
    for conflict in result.conflicts:
        lines.append(f"! {conflict}")
    lines.append("")

    if report_path is not None:
        report_path.write_text("\n".join(lines), encoding="utf-8")

    n_overrides = sum(
        1 for yg_id, _ in result.match_result.confident
        if yg_id in result.source_override_ids
    )
    n_manual = sum(
        1 for yg_id, _ in result.match_result.confident
        if yg_id in result.match_override_yg_ids
    )
    summary = (
        f"Merge summary:\n"
        f"  {len(result.match_result.confident):4d} confident matches\n"
        f"  {len(result.match_result.uncertain):4d} uncertain matches (flagged for review)\n"
        f"  {len(result.match_result.ygtree_unique):4d} ygtree-unique people added\n"
        f"  {n_overrides:4d} source overrides applied\n"
        f"  {n_manual:4d} manual match overrides applied\n"
        f"  {len(result.conflicts):4d} parent link conflicts (epatan parent kept)\n"
    )
    if report_path is not None:
        summary += f"\nFull report written to {report_path}\n"
    return summary


def merge_family_records(
    ep_families: Dict[str, FamilyRecord],
    yg_families: Dict[str, FamilyRecord],
    yg_to_unified: Dict[str, str],
) -> Tuple[Dict[str, FamilyRecord], List[str]]:
    """Merge ygtree families into epatan families. Returns (merged, conflict_log).

    Rules:
    - All epatan families kept as-is.
    - Each ygtree family: translate IDs, deduplicate by (husband, wife) pair.
    - New couples added; children already in ep child_map → logged as conflict, not added.
    """
    merged = dict(ep_families)
    conflicts: List[str] = []

    # Build ep (husband, wife) → fam_id index for deduplication
    ep_couples: Dict[Tuple[str, str], str] = {}
    for fam_id, fam in ep_families.items():
        ep_couples[(fam.husband_id, fam.wife_id)] = fam_id

    # Build ep child_map: child_id → fam_id (first parent family)
    ep_child_to_fam: Dict[str, str] = {}
    for fam_id, fam in ep_families.items():
        for child_id in fam.child_ids:
            if child_id not in ep_child_to_fam:
                ep_child_to_fam[child_id] = fam_id

    # Assign collision-safe IDs for ygtree families: fam10001, fam10002, …
    fam_counter = 10001

    for yg_fam_id, yg_fam in yg_families.items():
        # Translate IDs; drop any person not in the vault
        h = yg_to_unified.get(yg_fam.husband_id, "") if yg_fam.husband_id else ""
        w = yg_to_unified.get(yg_fam.wife_id, "") if yg_fam.wife_id else ""

        # Deduplication: same couple already exists in epatan → skip entirely
        if (h, w) in ep_couples:
            continue

        # Translate children; detect conflicts
        new_children = []
        for yg_child_id in yg_fam.child_ids:
            unified_child = yg_to_unified.get(yg_child_id, "")
            if not unified_child:
                continue
            if unified_child in ep_child_to_fam:
                ep_fam_id = ep_child_to_fam[unified_child]
                ep_fam = ep_families[ep_fam_id]
                conflicts.append(
                    f"{unified_child}: epatan parents=({ep_fam.husband_id},{ep_fam.wife_id}), "
                    f"ygtree parents=({h},{w}) — epatan kept"
                )
            else:
                new_children.append(unified_child)

        # Use a collision-safe ID so ygtree families never overwrite epatan families
        safe_fam_id = f"fam{fam_counter:05d}"
        fam_counter += 1

        new_fam = dataclasses.replace(
            yg_fam,
            id=safe_fam_id,
            husband_id=h,
            wife_id=w,
            child_ids=new_children,
        )
        merged[safe_fam_id] = new_fam

    return merged, conflicts
