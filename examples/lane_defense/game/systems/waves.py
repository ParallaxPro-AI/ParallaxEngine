"""The husk wave schedule."""

import random

from parallax import System, system, vec3
from parallax.combat import Health
from project import Scenes, Text

from game.components import Husk, Planted
from game.config import GardenRules
from game.content import LaneRule, WaveDef
from game.lawn import SPAWN_TURN, current_level, husk_count, lane_z
from game.notes import announce
from game.resources import WaveState
from game.audio import Sounds, play


@system("waves", scenes=[Scenes.garden])
class Waves(System):
    """Starts each wave `buildup`/`interval` seconds after the last one began (once it has
    finished spawning), then spawns its husks one gap apart, choosing lanes by the wave's
    rule: round-robin, random, or every open lane at once."""

    def update(self, ctx, dt):
        level = current_level(ctx)
        state = ctx.get(WaveState)
        if state.wave == 0 and level.waits_for_defender and not self.has_defender(ctx):
            state.countdown_from = ctx.time.now
            return
        wave = level.waves[state.wave - 1] if state.wave else None
        if wave and state.spawned < husk_count(level, wave):
            if ctx.time.now >= state.next_spawn_at:
                self.spawn_next(ctx, state, wave)
        elif state.wave < len(level.waves) and ctx.time.now >= state.countdown_from + self.wait_before(ctx, state):
            self.start_wave(ctx, state, level.waves[state.wave])

    def wait_before(self, ctx, state) -> float:
        level = current_level(ctx)
        return level.buildup if state.wave == 0 else level.interval

    def has_defender(self, ctx) -> bool:
        return any(planted.kind.data.defends for _, planted in ctx.world.query(Planted))

    def start_wave(self, ctx, state, wave: WaveDef):
        state.wave += 1
        state.spawned = 0
        state.countdown_from = ctx.time.now
        state.next_spawn_at = ctx.time.now + wave.spawn_gap
        final = state.wave == len(current_level(ctx).waves)
        if wave.banner is not None:
            announce(ctx, ctx.text(wave.banner))
        elif final:
            announce(ctx, ctx.text(Text.banner_final_wave))
        else:
            announce(ctx, ctx.text(Text.banner_wave, number=state.wave))
        play(ctx, ctx.config(Sounds).wave_start)

    def spawn_next(self, ctx, state, wave: WaveDef):
        lanes = current_level(ctx).lanes
        if wave.lanes is LaneRule.ALL:
            kind, lane = wave.husks[state.spawned // len(lanes)], lanes[state.spawned % len(lanes)]
        elif wave.lanes is LaneRule.RANDOM:
            kind, lane = wave.husks[state.spawned], random.choice(lanes)
        else:
            kind, lane = wave.husks[state.spawned], lanes[state.lane_turn % len(lanes)]
            state.lane_turn += 1
        husk = kind.data
        ctx.world.spawn(
            husk.prefab,
            at=vec3(ctx.config(GardenRules).spawn_x, 0, lane_z(ctx, lane)),
            rotation=SPAWN_TURN,
            components=[Husk(kind=kind, lane=lane, speed=husk.speed), Health(current=husk.health, max=husk.health)],
        )
        state.spawned += 1
        state.next_spawn_at += wave.spawn_gap
