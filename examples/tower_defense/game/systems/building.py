"""Picking pads and the building hotkeys."""

from parallax import System, system

from game.audio import Sounds
from game.actions import SiegeControls
from game.components import BattlefieldScene, BuildPad
from game.config import SiegeRules
from game.construction import build_on, cancel_build, sell_tower, upgrade_tower
from game.resources import Build


@system("building", scenes=[BattlefieldScene])
class Building(System):
    """Selects a pad (click it, or cycle with the shoulders) and builds the armed tower
    there. U, X and C do what the HUD's upgrade, sell and cancel buttons do. A click
    on the HUD never reaches the pads."""

    def update(self, ctx, dt):
        if ctx.input.pressed(SiegeControls.upgrade):
            upgrade_tower(ctx)
        if ctx.input.pressed(SiegeControls.sell):
            sell_tower(ctx)
        if ctx.input.pressed(SiegeControls.cancel):
            cancel_build(ctx)
        if ctx.input.pressed(SiegeControls.select):
            self.pick_pad_under_pointer(ctx)
        step = int(ctx.input.pressed(SiegeControls.next_pad)) - int(ctx.input.pressed(SiegeControls.previous_pad))
        if step:
            self.cycle_pads(ctx, step)

    def pick_pad_under_pointer(self, ctx):
        build = ctx.get(Build)
        point = ctx.input.pointer.world
        pad = ctx.world.query(tagged=BuildPad).near(point, ctx.config(SiegeRules).pad_pick_radius).nearest(point)
        if pad is None:
            build.armed = None
            return
        build.selected = pad
        ctx.audio.play(ctx.config(Sounds).spot_move, volume=0.2)
        if build.armed is not None:
            build_on(ctx, pad, build.armed)

    def cycle_pads(self, ctx, step):
        build = ctx.get(Build)
        pads = ctx.world.query(tagged=BuildPad).entities()
        index = pads.index(build.selected) + step if build.selected in pads else 0
        build.selected = pads[index % len(pads)]
