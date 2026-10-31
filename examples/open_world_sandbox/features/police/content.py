"""Crimes and the response at each star."""

from parallax import Localized, content, field


@content("crime")
class CrimeDef:
    """What one kind of crime adds to the wanted meter, and whether someone has to see it."""

    name: Localized = field()
    heat: float = field(1, min=0, doc="Stars added (fractions accumulate).")
    witnessed: bool = field(True, doc="Only counts if a pedestrian or officer can see the player.")
    witness_radius: float = field(40, min=0, unit="m")


@content("police_tier")
class PoliceTierDef:
    """What turns up at one star level."""

    stars: int = field(1, min=1, max=5)
    label: Localized = field()
    officers: int = field(2, min=0)
    cruisers: int = field(0, min=0)
    helicopters: int = field(0, min=0)
    roadblock: bool = field(False)
