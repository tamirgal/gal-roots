import re
import shutil
from pathlib import Path
from typing import Dict, List

from bs4 import BeautifulSoup

from .models import FamilyRecord, PersonRecord, PhotoEntry

GENDER_MAP = {
    "gender.male.gif": "male",
    "gender.female.gif": "female",
    "gender.unknown.gif": "unknown",
}

MONTH_MAP = {
    "jan": "01", "feb": "02", "mar": "03", "apr": "04",
    "may": "05", "jun": "06", "jul": "07", "aug": "08",
    "sep": "09", "oct": "10", "nov": "11", "dec": "12",
}


def _clean(text: str) -> str:
    """Collapse whitespace and strip."""
    return re.sub(r'\s+', ' ', text).strip()


def parse_birth_date(raw: str) -> str:
    """
    '29-May-1928' → '1928-05-29'
    'May-1928'    → '1928-05'
    '1928'        → '1928'
    anything else → raw (stored as-is)
    """
    raw = raw.strip()
    m = re.match(r'^(\d{1,2})-([A-Za-z]{3})-(\d{4})$', raw)
    if m:
        mon = MONTH_MAP.get(m.group(2).lower(), "00")
        return f"{m.group(3)}-{mon}-{int(m.group(1)):02d}"
    m = re.match(r'^([A-Za-z]{3})-(\d{4})$', raw)
    if m:
        mon = MONTH_MAP.get(m.group(1).lower(), "00")
        return f"{m.group(2)}-{mon}"
    m = re.match(r'^(\d{4})$', raw)
    if m:
        return m.group(1)
    return raw


def parse_person(html_path: Path) -> PersonRecord:
    """Parse an ind*.htm file into a PersonRecord. Reads all data into memory."""
    with open(html_path, encoding="windows-1252", errors="replace") as f:
        soup = BeautifulSoup(f, "html.parser")
    ind_id = html_path.stem

    # full_name from <title>
    title_tag = soup.find("title")
    raw_name = _clean(title_tag.get_text()) if title_tag else ""
    if not raw_name or "???" in raw_name or raw_name.strip("?").strip() == "":
        full_name = "Unknown"
    else:
        full_name = raw_name

    # gender from <img> src attribute
    gender = "unknown"
    for img in soup.find_all("img"):
        for key, val in GENDER_MAP.items():
            if key in img.get("src", ""):
                gender = val
                break

    # birth_date: text node "Born: ..."
    birth_date = ""
    body_text = soup.get_text(" ")
    m = re.search(r'Born:\s*(\S+(?:\s*-\s*\S+)*)', body_text)
    if m:
        birth_date = parse_birth_date(m.group(1).strip())

    # portrait: <img> in the 25%-width <td> of the first <table>
    portrait_src = ""
    first_table = soup.find("table")
    if first_table:
        td_25 = first_table.find("td", attrs={"width": "25%"})
        if td_25:
            img = td_25.find("img")
            if img:
                portrait_src = img.get("src", "")

    # family_as_spouse_ids: <a href="fam*.htm"> links (spouse family)
    # These appear under "Firstname 's Family" heading
    family_as_spouse_ids = []
    for u_tag in soup.find_all("u"):
        if "Family" in u_tag.get_text() and "Heritage" not in u_tag.get_text():
            parent_p = u_tag.find_parent("p") or u_tag.parent
            a = parent_p.find("a", href=re.compile(r"^fam\d+\.htm$"))
            if a:
                family_as_spouse_ids.append(a["href"].replace(".htm", ""))

    # biography: <p> containing "Comments:"
    # Convert <a href="HTML linked files/..."> to [[Documents/SLUG|text]] before stripping HTML
    biography = ""
    for p in soup.find_all("p"):
        if "Comments:" not in p.get_text(" "):
            continue
        for a in p.find_all("a", href=True):
            from urllib.parse import unquote
            href = unquote(a.get("href", ""))
            if "HTML linked files/" in href:
                stem = Path(href).stem
                slug = re.sub(r'\s+', '-', stem.strip())
                link_text = a.get_text(strip=True) or "Read more"
                a.replace_with(f"[[attachments/docs/{slug}|{link_text}]]")
        biography = _clean(p.get_text(" ").replace("Comments:", "").strip())
        break

    # picture album: <table> after "Picture Album" heading
    photos: List[PhotoEntry] = []
    for u_tag in soup.find_all("u"):
        if "Picture Album" in u_tag.get_text():
            parent_p = u_tag.find_parent("p") or u_tag.parent
            album_table = parent_p.find_next_sibling("table")
            if album_table:
                for row in album_table.find_all("tr"):
                    tds = row.find_all("td")
                    if len(tds) >= 2:
                        img = tds[0].find("img")
                        if img:
                            caption = _clean(tds[1].get_text())
                            photos.append(PhotoEntry(
                                src=img.get("src", ""),
                                caption=caption,
                            ))

    # has_docx: same-stem .docx exists alongside .htm
    has_docx = html_path.with_suffix(".docx").exists()

    return PersonRecord(
        id=ind_id,
        full_name=full_name,
        gender=gender,
        birth_date=birth_date,
        portrait_src=portrait_src,
        family_as_spouse_ids=family_as_spouse_ids,
        biography=biography,
        photos=photos,
        has_docx=has_docx,
    )


KNOWN_STATUSES = {"married", "divorced", "separated", "cohabiting"}


def parse_family(html_path: Path) -> FamilyRecord:
    """Parse a fam*.htm file into a FamilyRecord."""
    with open(html_path, encoding="windows-1252", errors="replace") as f:
        soup = BeautifulSoup(f, "html.parser")
    fam_id = html_path.stem

    # marriage_status: <p> immediately after <h2>
    marriage_status = "unknown"
    h2 = soup.find("h2")
    if h2:
        next_p = h2.find_next_sibling("p")
        if next_p:
            marriage_status = _clean(next_p.get_text()).lower()

    husband_id = ""
    wife_id = ""
    child_ids: List[str] = []

    for td in soup.find_all("td"):
        text = _clean(td.get_text())
        a = td.find("a", href=re.compile(r"^ind\d+\.htm$"))
        if not a:
            continue
        ind_id = a["href"].replace(".htm", "")
        if text.startswith("Husband:") or text.startswith("Conjoint:"):
            husband_id = ind_id
        elif text.startswith("Wife:"):
            wife_id = ind_id
        elif re.match(r"Child \d+:", text):
            child_ids.append(ind_id)

    return FamilyRecord(
        id=fam_id,
        husband_id=husband_id,
        wife_id=wife_id,
        marriage_status=marriage_status,
        child_ids=child_ids,
    )
