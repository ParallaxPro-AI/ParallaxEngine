"""Per-entity data: depots, each plane's cockpit and berth, and the markers the game looks for."""

from parallax import ContentRef, Vec3, component, field, tag

from game.content import IslandDef

Pilot = tag("pilot")
Plane = tag("plane")
Sea = tag("sea")
ObjectiveBeacon = tag("objective_beacon")


@component("depot")
class Depot:
    """The cargo pad of one island's airstrip."""
    island: ContentRef[IslandDef] = field()


@component("cockpit")
class Cockpit:
    """What the pilot has set, which the HUD reads back."""
    throttle: float = field(0, min=-1, max=1, doc="The lever; negative is reverse pitch on the ground.")
    flaps: float = field(0, min=0, max=1, doc="0 = up, 1 = full landing flap.")


@component("berth")
class Berth:
    """Where a plane is parked at the start: on its island's strip, facing down the runway.
    The home plane's berth is where a replacement airframe waits."""
    position: Vec3 = field()
    heading: float = field(90, unit="deg")
