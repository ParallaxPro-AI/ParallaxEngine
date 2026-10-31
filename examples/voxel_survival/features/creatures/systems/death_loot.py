from parallax import System, on, system, vec3
from parallax.combat import Died

from features.creatures.components import Loot
from features.inventory.feature import LootDropped
from game.content import roll


@system("death_loot")
class DeathLoot(System):
    """Creatures drop their loot table where they fall."""

    @on(Died, where=lambda event: event.entity.has(Loot))
    def dropped(self, ctx, event: Died):
        drops = event.entity.get(Loot).drops
        ctx.emit(LootDropped(stacks=roll(drops), at=event.entity.transform.position + vec3(0, 0.5, 0)))
