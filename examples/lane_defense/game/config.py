"""The house and the economy's fixed rules (config/garden.json). The board's size is
the lawn `Grid` in prefabs/lawn_grid.prefab.json."""

from parallax import config, field


@config("garden")
class GardenRules:
    house_x: float = field(unit="m", doc="A husk past this line has reached the house.")
    spawn_x: float = field(unit="m")
    house_health: int
    leak_damage: int = field(doc="House damage per husk that gets through.")
    dig_refund: float = field(min=0, max=1)
    water_cooldown: float = field(unit="s")
    three_star_health: int
    two_star_health: int
