"""Launches whoever lands on it."""

from parallax import Behavior, behavior, param, state
from parallax.characters import Character

from game.audio import Sounds, play
from game.components import Player


@behavior("bounce_pad")
class BouncePad(Behavior):
    """Launches the player straight up the moment they're standing on the pad,
    keeping their run speed. A short cooldown stops it firing twice."""

    launch_speed: float = param(18, unit="m/s")
    cooldown: float = param(0.3, unit="s")

    ready_at: float = state(0.0)

    def update(self, ctx, dt):
        if ctx.time.now < self.ready_at:
            return
        riders = ctx.world.query(Character, tagged=Player).where(lambda rider, character: character.ground == self.entity)
        for _, character in riders:
            character.launch(character.velocity.with_y(self.launch_speed))
            play(ctx, ctx.config(Sounds).boing, at=self.entity)
            self.ready_at = ctx.time.now + self.cooldown
