"""Hit feedback: every hit you land floats its damage over the bot."""

from parallax import Color, System, on, system
from parallax.combat import Damaged
from project import Scenes

from game.components import Bot, Player


@system("hit_numbers", scenes=[Scenes.arena])
class HitNumbers(System):
    @on(Damaged, where=lambda event: event.entity.has(Bot) and event.source is not None
        and event.source.alive and event.source.has(Player))
    def damage_number(self, ctx, event):
        at = event.point if event.point is not None else event.entity.transform.position
        ctx.ui.float_text(str(round(event.amount)), at, color=Color.hex("#ffd24d"))
