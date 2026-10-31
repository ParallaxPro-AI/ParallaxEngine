"""Pollen income."""

from parallax import Color, System, on, system, vec3
from project import Assets, Scenes

from game.events import PollenCollected
from game.resources import Pollen
from game.audio import Sounds, play

POLLEN_GOLD = Color.hex("#ffd84a")


@system("economy", scenes=[Scenes.garden])
class Economy(System):
    """Banks every collected mote. (Motes are made by the sky_pollen dropper and by
    pollen blooms; the starting pollen comes with the scene load, see gardens.replant.)"""

    @on(PollenCollected)
    def bank(self, ctx, event):
        ctx.get(Pollen).amount += event.amount
        ctx.ui.float_text(f"+{event.amount}", event.at + vec3(0, 0.4, 0), color=POLLEN_GOLD)
        ctx.vfx.play(Assets.vfx.pollen_burst, at=event.at)
        play(ctx, ctx.config(Sounds).pollen_pickup)
