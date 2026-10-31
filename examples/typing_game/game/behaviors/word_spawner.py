import random

from parallax import Behavior, behavior, state
from project import Prefabs

from game.components import Word
from game.config import Rules
from game.rules import random_word, roll_kind, spawn_interval


@behavior("word_spawner")
class WordSpawner(Behavior):
    """The uplink at the far end of the grid. Drops a word down a random column, more
    often the longer the run lasts. The word itself is drawn by the HUD."""

    spawn_at: float = state(0.0, doc="Run time of the next drop.")

    def start(self, ctx):
        self.spawn_at = ctx.time.now + spawn_interval(ctx)

    def update(self, ctx, dt):
        if ctx.time.now < self.spawn_at:
            return
        self.spawn_at = ctx.time.now + spawn_interval(ctx)
        at = self.entity.transform.position.with_x(random.choice(ctx.config(Rules).columns))
        ctx.world.spawn(Prefabs.packet, at=at,
                        components=[Word(text=random_word(ctx), kind=roll_kind(ctx))])
