from parallax import Animator, Behavior, behavior
from parallax.characters import Character


@behavior("player_animation", requires=[Animator, Character])
class PlayerAnimation(Behavior):
    """Feeds the body's ground speed to the animator, whose blend picks the model's own
    Idle, Walk and Run clips (the template's soccer_player did the same by name)."""

    def update(self, ctx, dt):
        self.entity.get(Animator).set_param("speed", self.entity.get(Character).velocity.flat().length())
