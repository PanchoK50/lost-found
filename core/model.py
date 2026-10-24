"""Typed data model for the challenge's building.json format.

Loading is strict: every cross-reference must resolve and every record must
follow the documented format (README section 3). Anything else raises ModelError
naming the offending id, so format drift surfaces at load time instead of in the
middle of a route computation. All entities are frozen; changes to a building
(closures, hypothetical doors) are expressed as parameters in core.graph, never
by mutating a loaded Building.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

OUTSIDE = "outside"
DOOR_PREFIX = "door:"

Point = tuple[float, float]

SPACE_TYPES = frozenset({"room", "corridor", "stair", "lift", "hall", "outdoor"})
OPENING_KINDS = frozenset({"door", "opening", "entrance"})
CONNECTOR_KINDS = frozenset({"stairs", "lift"})
ASSET_CATEGORIES = frozenset({"furniture", "fixture", "machine", "equipment"})


class ModelError(ValueError):
    """Raised when a building.json does not follow the documented format."""


@dataclass(frozen=True, slots=True)
class BuildingMeta:
    id: str
    name: str
    source: str
    license: str
    units: str = "m"
    split: str | None = None
    attribution: str | None = None
    source_ref: dict | None = None


@dataclass(frozen=True, slots=True)
class Floor:
    id: str
    level: int
    name: str
    elevation_m: float
    height_m: float


@dataclass(frozen=True, slots=True)
class Space:
    id: str
    floor_id: str
    type: str
    room_type: str
    name: str
    polygon: tuple[Point, ...]
    ref: str | None = None
    synthetic: bool = False


@dataclass(frozen=True, slots=True)
class Opening:
    id: str
    floor_id: str
    space_ids: tuple[str, str]
    kind: str
    position: Point
    width_m: float
    step_free: bool = True
    synthetic: bool = False


@dataclass(frozen=True, slots=True)
class Connector:
    id: str
    kind: str
    name: str
    floor_ids: tuple[str, ...]
    space_ids: tuple[str, ...]
    step_free: bool = False
    synthetic: bool = False


@dataclass(frozen=True, slots=True)
class Footprint:
    width_m: float
    depth_m: float
    rotation_deg: float = 0.0


@dataclass(frozen=True, slots=True)
class Asset:
    id: str
    name: str
    category: str
    type: str
    space_id: str
    floor_id: str
    position: Point
    footprint: Footprint | None = None
    source: str = "dataset"


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise ModelError(message)


def _number(value: object, context: str) -> float:
    _require(isinstance(value, (int, float)) and not isinstance(value, bool), f"{context}: expected a number")
    return float(value)  # type: ignore[arg-type]


def _point(value: object, context: str) -> Point:
    _require(
        isinstance(value, (list, tuple)) and len(value) == 2,
        f"{context}: expected [x, y], got {value!r}",
    )
    return (_number(value[0], context), _number(value[1], context))


def _text(value: object, context: str) -> str:
    _require(isinstance(value, str) and value != "", f"{context}: expected non-empty text")
    return value


class Building:
    """Immutable, validated view of one building plus derived lookup indexes."""

    def __init__(
        self,
        meta: BuildingMeta,
        floors: list[Floor],
        spaces: list[Space],
        openings: list[Opening],
        connectors: list[Connector],
        assets: list[Asset],
    ) -> None:
        self.meta = meta
        self.floors = self._unique(floors, "floor")
        self.spaces = self._unique(spaces, "space")
        self.openings = self._unique(openings, "opening")
        self.connectors = self._unique(connectors, "vertical connector")
        self.assets = self._unique(assets, "asset")
        self._validate_references()
        self._build_indexes()

    # ---------- construction ----------

    @staticmethod
    def _unique(items: list, label: str) -> dict:
        by_id: dict = {}
        for item in items:
            _require(item.id not in by_id, f"duplicate {label} id {item.id}")
            by_id[item.id] = item
        return by_id

    @classmethod
    def from_dict(cls, data: dict) -> "Building":
        _require(isinstance(data, dict), "building.json: expected a JSON object")
        for key in ("building", "floors", "spaces", "openings", "assets"):
            _require(key in data, f"building.json: missing top-level key '{key}'")
        info = data["building"]
        meta = BuildingMeta(
            id=_text(info.get("id"), "building.id"),
            name=_text(info.get("name"), "building.name"),
            source=_text(info.get("source"), "building.source"),
            license=_text(info.get("license"), "building.license"),
            units=_text(info.get("units", "m"), "building.units"),
            split=info.get("split"),
            attribution=info.get("attribution"),
            source_ref=info.get("source_ref"),
        )
        floors = [
            Floor(
                id=_text(item.get("id"), f"floors[{index}].id"),
                level=int(_number(item.get("level"), f"floors[{index}].level")),
                name=_text(item.get("name"), f"floors[{index}].name"),
                elevation_m=_number(item.get("elevation_m", 0.0), f"floors[{index}].elevation_m"),
                height_m=_number(item.get("height_m", 0.0), f"floors[{index}].height_m"),
            )
            for index, item in enumerate(data["floors"])
        ]
        spaces = [
            Space(
                id=_text(item.get("id"), f"spaces[{index}].id"),
                floor_id=_text(item.get("floor_id"), f"spaces[{index}].floor_id"),
                type=_text(item.get("type"), f"spaces[{index}].type"),
                room_type=_text(item.get("room_type"), f"spaces[{index}].room_type"),
                name=_text(item.get("name"), f"spaces[{index}].name"),
                polygon=cls._polygon(item.get("polygon"), f"spaces[{index}].polygon"),
                ref=item.get("ref"),
                synthetic=bool(item.get("synthetic", False)),
            )
            for index, item in enumerate(data["spaces"])
        ]
        openings = [
            Opening(
                id=_text(item.get("id"), f"openings[{index}].id"),
                floor_id=_text(item.get("floor_id"), f"openings[{index}].floor_id"),
                space_ids=cls._space_ids(item.get("space_ids"), f"openings[{index}].space_ids"),
                kind=_text(item.get("kind"), f"openings[{index}].kind"),
                position=_point(item.get("position"), f"openings[{index}].position"),
                width_m=_number(item.get("width_m"), f"openings[{index}].width_m"),
                step_free=bool(item.get("step_free", True)),
                synthetic=bool(item.get("synthetic", False)),
            )
            for index, item in enumerate(data["openings"])
        ]
        connectors = []
        for index, item in enumerate(data.get("vertical_connectors", [])):
            floor_ids = tuple(
                _text(entry, f"vertical_connectors[{index}].floor_ids") for entry in item.get("floor_ids", [])
            )
            space_ids = tuple(
                _text(entry, f"vertical_connectors[{index}].space_ids") for entry in item.get("space_ids", [])
            )
            connectors.append(
                Connector(
                    id=_text(item.get("id"), f"vertical_connectors[{index}].id"),
                    kind=_text(item.get("kind"), f"vertical_connectors[{index}].kind"),
                    name=_text(item.get("name"), f"vertical_connectors[{index}].name"),
                    floor_ids=floor_ids,
                    space_ids=space_ids,
                    step_free=bool(item.get("step_free", False)),
                    synthetic=bool(item.get("synthetic", False)),
                )
            )
        assets = []
        for index, item in enumerate(data["assets"]):
            raw_footprint = item.get("footprint")
            footprint = None
            if raw_footprint is not None:
                footprint = Footprint(
                    width_m=_number(raw_footprint.get("width_m"), f"assets[{index}].footprint.width_m"),
                    depth_m=_number(raw_footprint.get("depth_m"), f"assets[{index}].footprint.depth_m"),
                    rotation_deg=_number(raw_footprint.get("rotation_deg", 0.0), f"assets[{index}].footprint.rotation_deg"),
                )
            assets.append(
                Asset(
                    id=_text(item.get("id"), f"assets[{index}].id"),
                    name=_text(item.get("name"), f"assets[{index}].name"),
                    category=_text(item.get("category"), f"assets[{index}].category"),
                    type=_text(item.get("type"), f"assets[{index}].type"),
                    space_id=_text(item.get("space_id"), f"assets[{index}].space_id"),
                    floor_id=_text(item.get("floor_id"), f"assets[{index}].floor_id"),
                    position=_point(item.get("position"), f"assets[{index}].position"),
                    footprint=footprint,
                    source=_text(item.get("source", "dataset"), f"assets[{index}].source"),
                )
            )
        return cls(meta, floors, spaces, openings, connectors, assets)

    @classmethod
    def load(cls, path: Path | str) -> "Building":
        path = Path(path)
        building_file = path / "building.json" if path.is_dir() else path
        return cls.from_dict(json.loads(building_file.read_text(encoding="utf-8")))

    # ---------- parsing helpers ----------

    @staticmethod
    def _polygon(value: object, context: str) -> tuple[Point, ...]:
        _require(isinstance(value, (list, tuple)), f"{context}: expected a list of [x, y] points")
        points = tuple(_point(entry, context) for entry in value)
        _require(len(points) >= 3, f"{context}: needs at least 3 points, got {len(points)}")
        return points

    @staticmethod
    def _space_ids(value: object, context: str) -> tuple[str, str]:
        _require(
            isinstance(value, (list, tuple)) and len(value) == 2,
            f"{context}: expected exactly two space ids (or one plus 'outside')",
        )
        return (_text(value[0], context), _text(value[1], context))

    # ---------- validation ----------

    def _validate_references(self) -> None:
        for space in self.spaces.values():
            _require(space.floor_id in self.floors, f"space {space.id}: unknown floor_id {space.floor_id}")
            _require(space.type in SPACE_TYPES, f"space {space.id}: unknown type {space.type!r}")
        for opening in self.openings.values():
            _require(opening.floor_id in self.floors, f"opening {opening.id}: unknown floor_id {opening.floor_id}")
            _require(opening.kind in OPENING_KINDS, f"opening {opening.id}: unknown kind {opening.kind!r}")
            _require(
                opening.width_m > 0, f"opening {opening.id}: width_m must be positive, got {opening.width_m}"
            )
            real = [side for side in opening.space_ids if side != OUTSIDE]
            _require(len(real) >= 1, f"opening {opening.id}: must join at least one real space")
            for side in real:
                _require(side in self.spaces, f"opening {opening.id}: unknown space {side}")
        for connector in self.connectors.values():
            _require(connector.kind in CONNECTOR_KINDS, f"connector {connector.id}: unknown kind {connector.kind!r}")
            _require(
                len(connector.floor_ids) == len(connector.space_ids),
                f"connector {connector.id}: floor_ids and space_ids must have the same length",
            )
            for floor_id, space_id in zip(connector.floor_ids, connector.space_ids):
                _require(floor_id in self.floors, f"connector {connector.id}: unknown floor {floor_id}")
                _require(space_id in self.spaces, f"connector {connector.id}: unknown space {space_id}")
                space = self.spaces[space_id]
                _require(
                    space.floor_id == floor_id,
                    f"connector {connector.id}: stop {space_id} is on floor {space.floor_id}, not {floor_id}",
                )
        for asset in self.assets.values():
            _require(asset.category in ASSET_CATEGORIES, f"asset {asset.id}: unknown category {asset.category!r}")
            _require(asset.space_id in self.spaces, f"asset {asset.id}: unknown space {asset.space_id}")
            _require(asset.floor_id in self.floors, f"asset {asset.id}: unknown floor {asset.floor_id}")
            space = self.spaces[asset.space_id]
            _require(
                space.floor_id == asset.floor_id,
                f"asset {asset.id}: floor {asset.floor_id} does not match its space's floor {space.floor_id}",
            )

    # ---------- indexes ----------

    def _build_indexes(self) -> None:
        self.spaces_by_floor: dict[str, tuple[str, ...]] = {floor_id: () for floor_id in self.floors}
        self.openings_by_space: dict[str, list[str]] = {space_id: [] for space_id in self.spaces}
        self.assets_by_space: dict[str, list[str]] = {space_id: [] for space_id in self.spaces}
        self.assets_by_type: dict[str, list[str]] = {}
        for space_id, space in self.spaces.items():
            self.spaces_by_floor[space.floor_id] += (space_id,)
        for opening_id, opening in self.openings.items():
            for side in opening.space_ids:
                if side != OUTSIDE:
                    self.openings_by_space[side].append(opening_id)
        self.entrances: tuple[str, ...] = tuple(
            opening_id
            for opening_id, opening in self.openings.items()
            if OUTSIDE in opening.space_ids
        )
        for asset_id, asset in self.assets.items():
            self.assets_by_space[asset.space_id].append(asset_id)
            self.assets_by_type.setdefault(asset.type, []).append(asset_id)

    # ---------- lookups ----------

    def level(self, floor_id: str) -> int:
        return self.floors[floor_id].level

    def floors_sorted(self) -> list[Floor]:
        return sorted(self.floors.values(), key=lambda floor: floor.level)

    def floor_at_level(self, level: int) -> Floor | None:
        for floor in self.floors.values():
            if floor.level == level:
                return floor
        return None

    def floor_name(self, floor_id: str) -> str:
        return self.floors[floor_id].name

    def entrance_into(self, opening_id: str) -> str:
        """The space an entrance leads into (the side that is not 'outside')."""
        opening = self.openings[opening_id]
        return next(side for side in opening.space_ids if side != OUTSIDE)

    def describe_space(self, space_id: str) -> str:
        space = self.spaces[space_id]
        return f"{space.name} [{space_id}] on {self.floor_name(space.floor_id)}"
