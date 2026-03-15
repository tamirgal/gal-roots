from dataclasses import dataclass, field
from typing import List


@dataclass
class PhotoEntry:
    src: str
    caption: str


@dataclass
class PersonRecord:
    id: str
    full_name: str
    gender: str = "unknown"
    birth_date: str = ""
    portrait_src: str = ""
    family_as_spouse_ids: List[str] = field(default_factory=list)
    biography: str = ""
    photos: List[PhotoEntry] = field(default_factory=list)
    has_docx: bool = False


@dataclass
class FamilyRecord:
    id: str
    husband_id: str = ""
    wife_id: str = ""
    marriage_status: str = "unknown"
    child_ids: List[str] = field(default_factory=list)
