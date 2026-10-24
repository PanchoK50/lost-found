"""Entity resolution: free-text room, floor, room-type and asset-type mentions -> ids, deterministically.

Every resolver returns ranked candidates with a score and an `ambiguous` flag, so chat mode can ask back
and batch mode can commit to the best candidate."""

import re
import unicodedata
from dataclasses import dataclass, field

from rapidfuzz import fuzz, process

from lostfound.core.building import Building, MapError

FLOOR_QUALIFIER = re.compile(r"\s*\(((?:ground|floor|basement|level|mezzanine|roof)[^()]*)\)\s*$", re.IGNORECASE)
FUZZY_CUTOFF = 80
AMBIGUITY_MARGIN = 3


def fold(text: str) -> str:
    """Case-, accent- and whitespace-insensitive form: 'Büro ' -> 'buero'; 'Café' -> 'cafe'."""
    text = text.casefold().replace("ß", "ss")
    for umlaut, plain in (("ä", "ae"), ("ö", "oe"), ("ü", "ue")):
        text = text.replace(umlaut, plain)
    text = unicodedata.normalize("NFKD", text)
    text = "".join(char for char in text if not unicodedata.combining(char))
    return re.sub(r"\s+", " ", text.replace("_", " ")).strip()


@dataclass
class Resolution:
    query: str
    candidates: list[dict] = field(default_factory=list)  # {"id", "label", "score"}

    @property
    def best(self) -> str:
        if not self.candidates:
            raise MapError(f"Nothing matches '{self.query}'.")
        return self.candidates[0]["id"]

    @property
    def ambiguous(self) -> bool:
        return len(self.candidates) > 1 and self.candidates[0]["score"] - self.candidates[1]["score"] < AMBIGUITY_MARGIN

    def as_dict(self, limit: int = 5) -> dict:
        return {"query": self.query, "ambiguous": self.ambiguous, "candidates": self.candidates[:limit]}


class Resolver:
    def __init__(self, building: Building) -> None:
        self.building = building
        self.floor_names = {fold(floor["name"]): floor["id"] for floor in building.floors.values()}
        self.room_types = sorted({space["room_type"] for space in building.spaces.values()})
        self.asset_types = sorted({asset["type"] for asset in building.assets.values()})

    # ---------- floors ----------

    def floor(self, text: str) -> str:
        """'Ground floor', 'the floor 2', 'Floor 2', 'basement 1', 'level -1', '2' -> floor id."""
        folded = fold(text).removeprefix("the ").strip()
        if folded in self.floor_names:
            return self.floor_names[folded]
        if re.fullmatch(r"(ground( floor)?|eg|erdgeschoss|ground level)", folded):
            return self.building.floor_by_level(0)["id"]
        if match := re.fullmatch(r"(?:basement|untergeschoss|ug|b)\s*(\d+)", folded):
            return self.building.floor_by_level(-int(match.group(1)))["id"]
        if match := re.fullmatch(r"(?:floor|level|storey|og|etage)?\s*(-?\d+)(?:st|nd|rd|th)?(?: floor)?", folded):
            return self.building.floor_by_level(int(match.group(1)))["id"]
        raise MapError(f"Unknown floor '{text}'. Floors: {', '.join(f['name'] for f in self.building.floors.values())}.")

    # ---------- spaces ----------

    def space(self, text: str, floor_id: str | None = None) -> Resolution:
        """'Bedroom 2.10 (apartment 8) (Floor 2)', 'Büro (Ground floor)', '0.21', a space id -> ranked spaces."""
        building = self.building
        query = text.strip()
        if query in building.spaces:
            return Resolution(text, [self._candidate(query, 100)])
        if query in building.assets:
            return Resolution(text, [self._candidate(building.assets[query]["space_id"], 100)])
        if match := FLOOR_QUALIFIER.search(query):
            try:
                floor_id = self.floor(match.group(1))
                query = query[: match.start()].strip()
            except MapError:
                pass
        spaces = [s for s in building.spaces.values() if floor_id is None or s["floor_id"] == floor_id]
        folded = fold(query)
        exact = [s["id"] for s in spaces if fold(s["name"]) == folded]
        exact += [s["id"] for s in spaces if (s.get("ref") or "") and fold(s["ref"]) == folded and s["id"] not in exact]
        if exact:
            return Resolution(text, [self._candidate(space_id, 100) for space_id in exact])
        choices = {s["id"]: fold(f"{s['name']} {s.get('ref') or ''}") for s in spaces}
        ranked = process.extract(folded, choices, scorer=fuzz.WRatio, limit=8, score_cutoff=FUZZY_CUTOFF)
        return Resolution(text, [self._candidate(space_id, round(score, 1)) for _, score, space_id in ranked])

    def mentions(self, text: str) -> list[dict]:
        """All space names mentioned in a sentence, longest match first, non-overlapping, each with its floor
        qualifier when one follows ('Office 0.29 (Ground floor)')."""
        folded_text = fold(text)
        by_name: dict[str, list[str]] = {}
        for space in self.building.spaces.values():
            by_name.setdefault(fold(space["name"]), []).append(space["id"])
        taken: list[tuple[int, int]] = []
        found = []
        for name in sorted(by_name, key=len, reverse=True):
            if len(name) < 2:
                continue
            for match in re.finditer(rf"(?<![\w.]){re.escape(name)}(?![\w])", folded_text):
                start, end = match.span()
                if any(start < taken_end and end > taken_start for taken_start, taken_end in taken):
                    continue
                candidates = by_name[name]
                qualifier = re.match(r"\s*\(([^()]*)\)", folded_text[end:])
                if qualifier and len(candidates) > 1:
                    try:
                        floor_id = self.floor(qualifier.group(1))
                        candidates = [c for c in candidates if self.building.spaces[c]["floor_id"] == floor_id] or candidates
                    except MapError:
                        pass
                taken.append((start, end))
                found.append({"start": start, "text": name, "space_ids": candidates})
        return sorted(found, key=lambda item: item["start"])

    def _candidate(self, space_id: str, score: float) -> dict:
        return {"id": space_id, "label": self.building.label(space_id), "score": score}

    # ---------- types ----------

    def room_type(self, text: str) -> str:
        return self._type(text, self.room_types, "room type")

    def asset_type(self, text: str) -> str:
        return self._type(text, self.asset_types, "asset type")

    def _type(self, text: str, vocabulary: list[str], what: str) -> str:
        folded = fold(text)
        variants = {folded, folded.removesuffix("s"), folded.removesuffix("es"), re.sub(r"ies$", "y", folded)}
        for item in vocabulary:
            if fold(item) in variants:
                return item
        match = process.extractOne(folded, {item: fold(item) for item in vocabulary}, scorer=fuzz.WRatio, score_cutoff=88)
        if match:
            return match[2]
        raise MapError(f"Unknown {what} '{text}'. Known: {', '.join(vocabulary)}.")
