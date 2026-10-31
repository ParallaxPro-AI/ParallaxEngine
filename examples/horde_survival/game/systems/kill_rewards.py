import random

from parallax import System, Vec2, on, system, vec3
from parallax.combat import Died, Health
from project import Assets, Prefabs, Scenes

from game.components import Build, Foe, SoulMote
from game.horde import spawn_foe
from game.resources import Run
from game.rules import Rules, play, run_live, scales, survivor


@system("kill_rewards", scenes=[Scenes.arena])
class KillRewards(System):
    """What every kill pays while the run is live: score times the kill chain, a soul
    mote, maybe an ember heart, lifesteal, and for a brood sac the swarmlings inside it."""

    @on(Died, when=run_live, where=lambda event: event.entity.has(Foe))
    def foe_died(self, ctx, event: Died):
        foe = event.entity.get(Foe)
        rules = ctx.config(Rules)
        enemy = foe.kind.data
        run = ctx.get(Run)
        at = event.entity.transform.position

        run.kills += 1
        chained = ctx.time.now - run.last_kill_at <= rules.combo_window
        run.combo = min(rules.combo_max, run.combo + rules.combo_per_kill) if chained else 1.0
        run.last_kill_at = ctx.time.now
        run.score += (enemy.score + rules.kill_points) * run.combo * scales(ctx).score

        ctx.world.spawn(Prefabs.soul_mote, at=at, components=[SoulMote(xp=enemy.xp)])
        if random.random() < enemy.heart_chance:
            ctx.world.spawn(Prefabs.ember_heart, at=at)
        hero = survivor(ctx)
        if hero.get(Build).lifesteal:
            hero.get(Health).heal(hero.get(Build).lifesteal)
        if enemy.split_into is not None:
            vigil = scales(ctx)
            for k in range(enemy.split_count):
                offset = Vec2.from_angle(360 * k / enemy.split_count, enemy.split_spread).to_ground()
                spawn_foe(ctx, enemy.split_into, at + offset, vigil.hp, vigil.speed)
        # Throttled: at eight kills a second, a burst and a bang per kill is mud.
        if ctx.time.now >= run.kill_fx_at:
            run.kill_fx_at = ctx.time.now + rules.kill_fx_interval
            ctx.vfx.play(Assets.vfx.kill_sparks, at=at + vec3(0, 0.9, 0))
        if ctx.time.now >= run.kill_sound_at:
            run.kill_sound_at = ctx.time.now + rules.kill_sound_interval
            play(ctx, rules.sounds.kill)
