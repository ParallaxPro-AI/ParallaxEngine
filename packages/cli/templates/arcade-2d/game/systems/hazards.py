"""Rocks rain down; the run ends when one touches the player."""

import random

from parallax import System, system, vec2
from project import Placed, Prefabs, Scenes

from game.components import Rock
from game.config import Rules
from game.resources import Best, Run, in_play, score

HIT_DISTANCE = 0.9
"""Half the player's width plus half a rock's (prefabs: 1.0 and 0.8 wide)."""


@system("hazards", scenes=[Scenes.main], when=in_play)
class Hazards(System):
    """Counts the survival time, spawns rocks and ends the run on a hit. Systems have
    no fields: the timer lives in the `Run` resource."""

    def update(self, ctx, dt):
        run = ctx.get(Run)
        rules = ctx.config(Rules)
        run.time += dt

        run.until_spawn -= dt
        if run.until_spawn <= 0:
            run.until_spawn = rules.spawn_every
            # `random` is seeded by the engine, so playtests are deterministic.
            x = random.uniform(-rules.spread, rules.spread)
            ctx.world.spawn(Prefabs.rock, at=vec2(x, rules.spawn_height))

        player = ctx.world.placed(Placed.player).transform.position
        for rock in ctx.world.query(tagged=Rock):
            at = rock.transform.position
            if abs(at.x - player.x) < HIT_DISTANCE and abs(at.y - player.y) < HIT_DISTANCE:
                run.over = True
                best = ctx.get(Best)
                best.score = max(best.score, score(run))
                ctx.camera.main.shake(0.2, 0.3)
                return
