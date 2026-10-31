from parallax import Color, System, Vec3, on, system
from parallax.vehicles import VehicleLanded
from project import Assets, Scenes, Text

from game.components import Sea
from game.config import FreightRules
from game.content import UpgradeStat
from game.cues import Cues, play
from game.events import PlaneLost
from game.feed import Kind, say
from game.resources import Board
from game.rules import upgrade_total


@system("landings", scenes=[Scenes.archipelago])
class Landings(System):
    """Grades each touchdown on its real sink rate. Soft enough is a greased landing,
    worth a bonus on the drop; too hard breaks fragile cargo; harder still breaks the
    plane. Reinforced gear raises both limits. Touching down on the sea is a ditching.
    A touchdown is a `VehicleLanded`: at least 0.3 s airborne, so taxiway bumps and
    hops off the pad are not graded."""

    @on(VehicleLanded)
    def grade(self, ctx, event):
        if event.target is not None and event.target.has(Sea):
            ctx.emit(PlaneLost(plane=event.entity, ditched=True))
            return
        rules = ctx.config(FreightRules)
        cues = ctx.config(Cues)
        sink = event.fall_speed
        gear = upgrade_total(ctx, UpgradeStat.GEAR)
        board = ctx.get(Board)
        carrying_fragile = board.loaded and board.contract.cargo.data.fragile

        if sink >= rules.crash_sink + gear:
            ctx.emit(PlaneLost(plane=event.entity, ditched=False))
            return
        ctx.vfx.play(Assets.vfx.touchdown_dust, at=event.entity.transform.position + Vec3(0, 0.3, 0))
        if sink >= rules.hard_sink + gear:
            ctx.camera.main.shake(0.55, 0.32)
            ctx.ui.flash(event.entity, color=Color.hex("#ffb020"))
            play(ctx, cues.heavy_landing)
            if carrying_fragile and not board.damaged:
                board.damaged = True
                say(ctx, ctx.text(Text.load_broken), Kind.BAD)
            else:
                say(ctx, ctx.text(Text.heavy_landing, sink=f"{sink:.1f}"), Kind.BAD)
        elif sink <= rules.grease_sink:
            board.greased = board.greased or board.loaded
            play(ctx, cues.greased)
            say(ctx, ctx.text(Text.greased_it, sink=f"{sink:.1f}"), Kind.GOOD)
        else:
            say(ctx, ctx.text(Text.down_safe, sink=f"{sink:.1f}"))
