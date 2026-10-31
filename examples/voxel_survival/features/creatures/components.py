from parallax import ContentRef, component, field, tag

from game.content import Drop, MobDef

Wildlife = tag("wildlife")


@component("mob")
class Mob:
    """Which roster entry this hostile is; its numbers come from the entry."""
    kind: ContentRef[MobDef] = field()


@component("loot")
class Loot:
    """Dropped where the creature dies."""
    drops: list[Drop] = field([])
