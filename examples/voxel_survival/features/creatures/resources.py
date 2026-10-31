from parallax import field, resource
from parallax.voxels import Cell3


@resource("waves")
class Waves:
    wave: int = field(0, min=0, doc="Nights survived so far drive the difficulty.")
    danger: bool = field(False, doc="Hostiles are out (night, or a siege).")
    spawn_in: float = field(0, unit="s")


@resource("siege")
class Siege:
    """The beacon expedition: hold the ground around a lit beacon until the timer runs out."""
    seconds_left: float = field(0, unit="s")
    beacon: Cell3 | None = field(None)
    held: bool = field(False)


@resource("herd")
class Herd:
    spawn_in: float = field(3, unit="s")
    spawned: int = field(0, doc="Walks the spawn angle round the player.")
