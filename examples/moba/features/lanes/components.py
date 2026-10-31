from parallax import ContentRef, component, field

from game.content import LaneDef, UnitDef


@component("minion")
class Minion:
    """A lane unit: which role it is and which lane it walks."""
    unit: ContentRef[UnitDef] = field()
    lane: ContentRef[LaneDef] = field()
    backwards: bool = field(False, doc="Walks the lane path from the red end.")


@component("aggressor")
class Aggressor:
    """This champion recently hit an enemy champion; towers prefer it until `until`."""
    until: float = field(0, unit="s")
