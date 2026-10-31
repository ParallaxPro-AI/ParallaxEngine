import random

from parallax import ContentRef, System, system
from parallax.combat import Health
from project import Prefabs

from features.creatures.components import Loot, Mob
from features.creatures.events import WaveStarted
from features.creatures.resources import Siege, Waves
from features.creatures.spawning import ground_at, is_safe
from game.components import Hostile
from game.config import Rules
from game.content import MobDef
from game.world import day_number, the_player


@system("mob_waves")
class MobWaves(System):
    """Hostiles come out at night, and all day long during a beacon siege. Each
    night is a wave: the cap rises, spawns come faster and tougher mobs join the
    roster. They spawn in a ring around the player, never inside a torch's light,
    and are gone at dawn."""

    def update(self, ctx, dt):
        waves = ctx.get(Waves)
        siege = ctx.get(Siege).seconds_left > 0
        danger = siege or ctx.environment.is_night
        if danger and not waves.danger:
            waves.wave = max(waves.wave + 1, day_number(ctx))
            ctx.emit(WaveStarted(wave=waves.wave))
        if waves.danger and not danger:
            for mob in ctx.world.query(tagged=Hostile):
                mob.destroy()
        waves.danger = danger

        player = the_player(ctx)
        waves.spawn_in -= dt
        if not danger or player.get(Health).dead or waves.spawn_in > 0:
            return
        rules = ctx.config(Rules)
        cap = rules.siege_max_alive if siege else _by_wave(rules.wave_max_alive, waves.wave)
        waves.spawn_in = rules.siege_interval if siege else _by_wave(rules.wave_interval, waves.wave)
        if ctx.world.query(tagged=Hostile).count() >= cap:
            return
        spot = ground_at(ctx, player.transform.position, rules.spawn_radius, random.uniform(0, 360))
        if is_safe(ctx, spot):
            return
        kind = _pick(ctx, waves.wave)
        ctx.world.spawn(Prefabs.hostile_mob, at=spot, components=[Mob(kind=kind), Loot(drops=kind.data.drops)])


def _by_wave(values: list, wave: int):
    return values[min(max(wave, 1), len(values)) - 1]


def _pick(ctx, wave: int) -> ContentRef[MobDef]:
    """A roster entry unlocked by this wave, chosen by weight."""
    pool = ctx.content(MobDef).where(lambda mob: mob.min_wave <= wave)
    return random.choices(pool, weights=[m.data.weight for m in pool])[0]
