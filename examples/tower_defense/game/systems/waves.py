"""Sending the horde, one wave at a time, when the player is ready."""

import math
import random

from parallax import System, heading_to, on, system, vec3
from parallax.combat import Health
from project import Text

from game.audio import Sounds
from game.actions import SiegeControls
from game.components import BattlefieldScene, Invader, Route
from game.config import SiegeRules
from game.content import EnemyDef
from game.events import WaveCleared, WaveStartRequested
from game.resources import Siege
from game.siege import current_level, wave_in_progress


@system("waves", scenes=[BattlefieldScene])
class Waves(System):
    """Waits for the player to send the next wave (Space or the HUD button), then marches
    its enemies out in shuffled order, a little faster every wave, scaled by the
    battlefield. A wave is cleared when its last enemy is dead or through. The march
    is owned by this system, so a retry or quit mid-wave ends it with the scene."""

    def update(self, ctx, dt):
        if ctx.input.pressed(SiegeControls.send_wave):
            ctx.emit(WaveStartRequested())

    @on(WaveStartRequested)
    def send(self, ctx, event):
        siege = ctx.get(Siege)
        waves = current_level(ctx).waves
        if wave_in_progress(ctx) or siege.wave == len(waves):
            return
        siege.wave += 1
        siege.leaked_this_wave = False
        wave = waves[siege.wave - 1].data
        ctx.ui.announce(ctx.text(Text.boss_wave if wave.boss else Text.wave_number, number=siege.wave), wave.announce)
        siege.march = ctx.run(self.march)

    async def march(self, ctx, task):
        """The wave just sent: spawn it, wait for the field to clear, pay out."""
        rules, siege = ctx.config(SiegeRules), ctx.get(Siege)
        number, waves = siege.wave, current_level(ctx).waves
        wave = waves[number - 1].data
        gap = max(rules.min_spawn_gap, rules.spawn_gap + rules.spawn_gap_per_wave * (number - 1))
        horde = [group.enemy for group in wave.groups for _ in range(group.count)]
        random.shuffle(horde)
        await task.seconds(rules.first_spawn_delay)
        for enemy in horde:
            self.spawn(ctx, enemy)
            await task.seconds(gap)
        await task.until_true(lambda: ctx.world.query(Invader).count() == 0)
        ctx.emit(WaveCleared(number=number, boss=wave.boss))
        if number < len(waves) and waves[number].data.boss:
            ctx.ui.toast(Text.boss_next)
            ctx.audio.play(ctx.config(Sounds).boss_warning, volume=0.45)

    def spawn(self, ctx, enemy):
        level = current_level(ctx)
        foe: EnemyDef = enemy.data
        _, route = ctx.world.query(Route).single()
        health = math.floor(foe.health * level.hp_mul)
        ctx.world.spawn(
            foe.prefab,
            at=route.points[0],
            rotation=vec3(0, heading_to(route.points[0], route.points[1]), 0),
            components=[
                Invader(kind=enemy, speed=foe.speed * level.speed_mul),
                Health(current=health, max=health, flat_armor=foe.armor + level.armor_add),
            ],
        )
