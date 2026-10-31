"""A platform that won't hold you for long."""

import math

from parallax import Behavior, Vec3, behavior, param, state, vec3
from parallax.characters import Character
from project import Assets

from game.audio import Sounds, play
from game.components import Player
from game.events import Crumbled


@behavior("crumble_block")
class CrumbleBlock(Behavior):
    """Stand on it and it starts to shake; `delay` seconds later it falls away.
    It can't bring itself back (it's gone), so it reports `Crumbled` and the
    level puts a fresh one in its place after a while."""

    delay: float = param(0.7, unit="s")
    wobble: float = param(0.07, unit="m")

    origin: Vec3 = state(Vec3.ZERO)
    falls_at: float | None = state(None)

    def start(self, ctx):
        self.origin = self.entity.transform.position

    def update(self, ctx, dt):
        if self.falls_at is None:
            if ctx.world.query(Character, tagged=Player).where(lambda rider, character: character.ground == self.entity).first():
                self.falls_at = ctx.time.now + self.delay
                play(ctx, ctx.config(Sounds).creak, at=self.entity)
            return
        if ctx.time.now < self.falls_at:
            shake = math.sin(ctx.time.now * 42) * self.wobble
            self.entity.transform.position = self.origin + vec3(shake, 0, 0)
            return
        ctx.vfx.play(Assets.vfx.dust, at=self.origin)
        ctx.emit(Crumbled(prefab=self.entity.prefab, at=self.origin))
        self.entity.destroy()
