"""Content registries: the gems, the stages of the descent and the relics."""

from parallax import Color, ImageRef, Localized, Vec2, content, field


@content("gem", order="unlock")
class GemDef:
    """One gem kind. The sprite carries its own colour; `color` tints its clear burst."""
    unlock: int = field(min=1, doc="Stages bring gem kinds into play in this order.")
    image: ImageRef = field()
    size: Vec2 = field(doc="Drawn size in meters; each gem keeps its native aspect ratio.")
    color: Color = field()


@content("stage", order="depth")
class StageDef:
    """One shelf of the descent, played in `depth` order. Cleared by reaching `target`
    points AND chipping every crusted cell before the moves run out."""
    depth: int = field(min=1)
    name: Localized = field()
    hint: Localized = field()
    target: int = field(min=1)
    moves: int = field(min=1)
    gem_kinds: int = field(min=3, doc="How many gem kinds are in play, in unlock order.")
    crust: list[str] = field([], doc="The board as text, top row first; '#' is a crusted cell.")
    crust_layers: int = field(1, min=1, doc="Hits each crusted cell takes.")


@content("relic")
class RelicDef:
    """A run modifier drafted between stages. Every field adds to the run's total."""
    name: Localized = field()
    description: Localized = field()
    short: Localized = field(doc="The description on a phone's narrower draft card.")
    highlight: Localized = field(doc="The phrase the draft card lights in the relic's colour; part of both descriptions.")
    extra_moves: int = field(0, doc="Added to every remaining stage's moves.")
    score_bonus: float = field(0.0, doc="Fraction added to every score gain.")
    cascade_bonus: float = field(0.0, doc="Added to each cascade step's multiplier.")
    start_bombs: int = field(0, doc="Bomb gems seeded at the start of every stage.")
    start_lines: int = field(0, doc="Line gems seeded at the start of every stage.")
    thaw: bool = field(False, doc="Clearing a gem also chips crust beside it.")
    refund_on_special: bool = field(False, doc="Forging a special refunds the move.")
    fewer_kinds: int = field(0, doc="Gem kinds removed from play.")
    bomb_radius_bonus: int = field(0, doc="Added to a bomb's blast radius.")
    leftover_bonus: float = field(0.0, doc="Fraction added to the leftover-moves bonus.")
