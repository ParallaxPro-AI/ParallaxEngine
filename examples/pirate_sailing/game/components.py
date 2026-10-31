"""Per-entity data. Fields another machine needs are replicated: to everyone when every
client draws them, to the owner when only that captain's HUD reads them."""

from parallax import Entity, component, field, tag

CrewShip = tag("crew_ship")
TreasureChest = tag("treasure")
Ghost = tag("ghost")
Kraken = tag("kraken")
Shark = tag("shark")
CursedHoard = tag("cursed_hoard")
"""A treasure contract's hoard: raising it counts towards the contract, not the hold."""

Crew = tag("side_crew")
Sea = tag("side_sea")


@component("rig")
class Rig:
    """How a ship is sailed: what the helm has set."""
    sail: float = field(0, min=0, max=1, replicate=True, doc="0 = furled, 1 = full sail. Every client draws the canvas.")
    anchored: bool = field(False, replicate="owner")


@component("broadsides")
class Broadsides:
    """The two gun decks: balls left in each rack, and reload progress once a rack is empty.
    The refit build stacks extra balls on `rack` as a modifier when the ship launches."""
    rack: int = field(4, min=1, replicate="owner", modifiable=True)
    port: int = field(4, min=0, replicate="owner")
    starboard: int = field(4, min=0, replicate="owner")
    port_reload: float = field(0, min=0, max=1, replicate="owner", doc="0 = loaded, else fraction done.")
    starboard_reload: float = field(0, min=0, max=1, replicate="owner")


@component("cannonball")
class Cannonball:
    shooter: Entity = field()
    damage: float = field(min=0)


@component("bounty")
class Bounty:
    """Gold paid into the purse when this hull goes down."""
    gold: int = field(min=0)


@component("squall")
class Squall:
    """A squall over the whole sea. Its prefab's EnvironmentZone is the look and the
    scene's storm weather the sound; while one exists, sails lose bite and guns lose reach."""
    ends_at: float = field(unit="s", doc="Game time it blows out.")
