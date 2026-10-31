import math

from parallax import System, on, system
from parallax.combat import Died, Health

from game.build import find_wisp
from game.components import Guardian, Wisp
from game.config import Points
from game.events import BloomCollected, Grazed, WaveCleared, WispHurt
from game.resources import Chain, Run


@system("scoring")
class Scoring(System):
    """Score and the kill chain. Kills close together climb a multiplier that also
    boosts graze and bloom points; getting hurt drops it to x1. Each cleared wave
    pays a growing bonus, and winning pays for every petal, shield and bomb left."""

    def update(self, ctx, dt):
        if ctx.get(Chain).window.tick(dt):
            ctx.reset(Chain)

    @on(Died, where=lambda event: event.entity.has(Guardian))
    def guardian_banished(self, ctx, event: Died):
        points = ctx.config(Points)
        chain = ctx.get(Chain)
        chain.kills += 1
        chain.window.restart(points.chain_window)
        chain.multiplier = min(points.max_multiplier, 1 + math.floor(chain.kills * points.chain_gain))
        ctx.get(Run).score += event.entity.get(Guardian).kind.data.score * chain.multiplier

    @on(Grazed)
    def grazed(self, ctx, event: Grazed):
        run = ctx.get(Run)
        run.graze += 1
        run.score += ctx.config(Points).graze_score * ctx.get(Chain).multiplier

    @on(BloomCollected)
    def bloom_collected(self, ctx, event: BloomCollected):
        ctx.get(Run).score += ctx.config(Points).bloom_score * ctx.get(Chain).multiplier

    @on(WispHurt)
    def hurt(self, ctx, event: WispHurt):
        ctx.reset(Chain)

    @on(WaveCleared)
    def wave_cleared(self, ctx, event: WaveCleared):
        points = ctx.config(Points)
        run = ctx.get(Run)
        run.score += points.wave_bonus * run.waves_cleared
        if event.final:
            wisp = find_wisp(ctx)
            health = wisp.get(Health)
            run.score += int(health.current * points.win_bonus_per_life
                             + health.shield * points.win_bonus_per_shield
                             + wisp.get(Wisp).bombs * points.win_bonus_per_bomb)
