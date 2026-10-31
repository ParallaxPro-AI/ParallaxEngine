from parallax import System, on, system
from parallax.combat import Died
from project import Content, Prefabs

from game.audio import Sounds
from features.inventory.feature import Equipment, Inventory, is_empty
from features.survival.lives import run_over
from features.survival.resources import Run
from game.components import Player
from game.content import Stack


@system("respawning")
class Respawning(System):
    """Death keeps the world and costs the backpack: what you carried is left in
    a grave where you fell. A challenge run that has used up its lives is over and
    its save is deleted. The death and game-over screens open by themselves (their
    `when=`), and the death screen's button wakes you at home."""

    @on(Died, where=lambda event: event.entity.has(Player))
    def died(self, ctx, event: Died):
        player = event.entity
        backpack = player.get(Inventory)
        if not is_empty(backpack.slots):
            ctx.world.spawn(Prefabs.grave, at=player.transform.position,
                            components=[Inventory(size=backpack.size, slots=backpack.slots)])
        backpack.slots = [Stack()] * backpack.size
        player.get(Equipment).tool = Content.item.bare_hands
        ctx.audio.play(ctx.config(Sounds).death)
        ctx.get(Run).deaths += 1
        if run_over(ctx):
            ctx.save.delete("world")
