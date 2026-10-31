"""Coin patterns, collection and the streak multiplier."""

import random

from parallax import System, TriggerEntered, on, system, vec2
from parallax.combat import Damaged
from project import Prefabs, Scenes

from game.components import Coin, Hopper, Runner
from game.config import Canyon, Sounds
from game.content import Lane
from game.events import HazardPlaced, ScrolledOff
from game.resources import Run, running


@system("coins", scenes=[Scenes.canyon])
class Coins(System):
    """Lays coins around the hazards and runs the streak multiplier.

    Patterns: an arc along the runner's REAL hop over a ground hazard (solved
    from the live speed, because a hop traces a wider, flatter arc the faster
    the world moves), a chest-height line in the open gap (collected by NOT
    hopping), or a line threaded under a wingling (only a committed duck gets it).

    Every `streak_step` coins collected without letting one scroll past raises
    the multiplier; a missed coin or a hit resets it."""

    @on(HazardPlaced)
    def lay(self, ctx, event: HazardPlaced):
        cfg = ctx.config(Canyon)
        if event.lead_in:
            self.arc(ctx, event.x)
        elif random.random() >= ctx.get(Run).stage.data.coin_chance:
            return
        elif event.kind.data.lane is Lane.AIR:
            self.line(ctx, event.x, cfg.duck_line_count, cfg.duck_line_spacing, cfg.duck_line_y)
        elif random.random() < 0.5:
            self.arc(ctx, event.x)
        else:
            self.line(ctx, event.x + event.gap / 2, cfg.line_count, cfg.line_spacing, cfg.line_y)

    @on(TriggerEntered, when=running, where=lambda e: e.entity.has(Coin) and e.target.has(Runner))
    def collect(self, ctx, event: TriggerEntered):
        event.entity.destroy()
        cfg = ctx.config(Canyon)
        run = ctx.get(Run)
        run.streak += 1
        run.multiplier = min(cfg.max_multiplier, 1 + run.streak // cfg.streak_step)
        run.coins += cfg.coin_value * run.multiplier
        ctx.audio.play(ctx.config(Sounds).coin)

    @on(ScrolledOff)
    def missed(self, ctx, event: ScrolledOff):
        if event.entity.has(Coin):
            self.break_streak(ctx)

    @on(Damaged)
    def hit(self, ctx, event: Damaged):
        self.break_streak(ctx)

    def break_streak(self, ctx):
        run = ctx.get(Run)
        run.streak, run.multiplier = 0, 1

    def arc(self, ctx, centre_x):
        """y(u) = rest + peak - g*u^2 / (2*v^2), centred on the hazard."""
        cfg = ctx.config(Canyon)
        _, hopper = ctx.world.query(Hopper).single()
        speed = max(1.0, ctx.get(Run).speed)
        peak = hopper.hop_speed ** 2 / (2 * hopper.gravity)
        half = speed * hopper.hop_speed / hopper.gravity * cfg.arc_span
        rest_y = cfg.ground_y + hopper.height / 2
        for i in range(cfg.arc_count):
            u = -half + 2 * half * i / (cfg.arc_count - 1)
            fall = 0.5 * hopper.gravity * (u / speed) ** 2
            self.spawn(ctx, centre_x + u, rest_y + max(0.0, peak - fall))

    def line(self, ctx, centre_x, count, spacing, y):
        for i in range(count):
            self.spawn(ctx, centre_x + (i - (count - 1) / 2) * spacing, y)

    def spawn(self, ctx, x, y):
        ctx.world.spawn(Prefabs.coin, at=vec2(x, y))
