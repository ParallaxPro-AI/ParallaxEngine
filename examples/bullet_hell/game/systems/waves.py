import random

from parallax import System, clamp, on, system, vec2
from parallax.combat import Health
from project import Prefabs, Scenes

from game.build import current_wave, is_final_wave
from game.components import Guardian
from game.config import Arena
from game.content import Flight
from game.events import UpgradePicked, WaveCleared, WaveStarted
from game.resources import Run, Spawner

VEE_SPACING = 0.9
SWAY_ENTRIES = 6


@system("waves", scenes=[Scenes.garden])
class Waves(System):
    """Runs the campaign: starts each wave, sends its guardians in one at a time in
    formation, and reports the wave cleared once every guardian is gone."""

    def start(self, ctx):
        self.begin(ctx, 0)

    @on(UpgradePicked)
    def next_wave(self, ctx, event: UpgradePicked):
        self.begin(ctx, ctx.get(Run).wave_index + 1)

    def update(self, ctx, dt):
        spawner = ctx.get(Spawner)
        run = ctx.get(Run)
        if spawner.sent < current_wave(ctx).data.count:
            if spawner.cooldown.tick(dt):
                self.send_guardian(ctx)
                spawner.cooldown.restart(ctx.config(Arena).spawn_gap)
        elif run.waves_cleared == run.wave_index and ctx.world.query(Guardian).count() == 0:
            run.waves_cleared += 1
            ctx.emit(WaveCleared(index=run.wave_index, final=is_final_wave(ctx)))

    def begin(self, ctx, index: int):
        ctx.get(Run).wave_index = index
        ctx.reset(Spawner)
        ctx.get(Spawner).cooldown.restart(ctx.config(Arena).spawn_first)
        wave = current_wave(ctx).data
        ctx.emit(WaveStarted(index=index, boss=wave.guardian.data.boss))

    def send_guardian(self, ctx):
        arena = ctx.config(Arena)
        spawner = ctx.get(Spawner)
        wave_ref = current_wave(ctx)
        wave = wave_ref.data
        hp = wave.guardian.data.hp * wave.hp_mul
        x = entry_x(wave.flight, spawner.sent, arena.field_half_width - 1)
        ctx.world.spawn(Prefabs.guardian, at=vec2(x, arena.field_top), components=[
            Guardian(kind=wave.guardian, wave=wave_ref, slot=spawner.sent),
            Health(current=hp, max=hp, destroy_on_death=False),
        ])
        spawner.sent += 1


def entry_x(flight: Flight, slot: int, lane: float) -> float:
    """Where the `slot`-th guardian of a formation enters across the top."""
    if flight is Flight.VEE:
        side = -1 if slot % 2 == 0 else 1
        return clamp(side * VEE_SPACING * ((slot + 1) // 2), -lane, lane)
    if flight is Flight.PLUNGE:
        return random.uniform(-lane, lane)
    if flight is Flight.ROOT:
        return -lane + 2 * lane * (slot % 3 + 0.5) / 3
    if flight is Flight.SOVEREIGN:
        return 0.0
    return -lane + (slot * 2 * lane / SWAY_ENTRIES) % (2 * lane)
