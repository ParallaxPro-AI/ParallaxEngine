"""Game-wide state."""

from enum import Enum

from parallax import ContentRef, field, resource
from parallax.values import Cell
from project import Content

from game.content import LevelDef, PlantDef


class Tool(Enum):
    NONE = "none"
    SEED = "seed"
    WATER = "water"
    DIG = "dig"


class Result(Enum):
    PLAYING = "playing"
    WON = "won"
    LOST = "lost"


@resource("campaign")
class Campaign:
    """Which garden is being played (kept through retries) and what the player has
    earned (kept forever)."""

    level: ContentRef[LevelDef] = field(Content.level.level_1, keep="session")
    stars: dict[ContentRef[LevelDef], int] = field({}, keep="profile", doc="Best stars per garden.")
    best_score: int = field(0, keep="profile")


@resource("pollen")
class Pollen:
    """The currency. Every seed costs pollen; motes and blooms earn it."""

    amount: int = field(0, min=0)


@resource("planting")
class Planting:
    """The armed tool, the hovered cell, and seed recharge timers."""

    tool: Tool = field(Tool.NONE)
    seed: ContentRef[PlantDef] | None = field(None)
    hover: Cell | None = field(None, doc="None when the pointer is off the lawn.")
    cursor: Cell = field(Cell(1, 2))
    cursor_active: bool = field(False, doc="Keys or a gamepad, not the pointer, pick the cell.")
    seed_ready_at: dict[ContentRef[PlantDef], float] = field({}, doc="Game time each seed is ready again.")


@resource("irrigation")
class Irrigation:
    """The watered row: its shooters fire faster and its blooms give more."""

    row: int = field(-1, doc="-1 before any row is watered.")
    ready_at: float = field(0, unit="s")


@resource("waves")
class WaveState:
    """Progress through the level's waves (deadlines, so it survives a save)."""

    wave: int = field(0, doc="Waves started so far.")
    spawned: int = field(0, doc="Husks spawned from the current wave.")
    countdown_from: float = field(0, unit="s", doc="When the wait for the next wave began.")
    next_spawn_at: float = field(0, unit="s")
    lane_turn: int = field(0, doc="Round-robin counter for CYCLE waves.")


@resource("garden")
class GardenState:
    """The house, the score and how the level ended."""

    house_health: int = field(0)
    score: int = field(0)
    kills: int = field(0)
    result: Result = field(Result.PLAYING)
    stars: int = field(0)
