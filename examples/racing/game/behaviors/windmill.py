from parallax import Behavior, Model, behavior, param


@behavior("windmill", tick="significance")
class Windmill(Behavior):
    """Turns the windmill's rotor joint (the code model's free hinge) on game time."""

    rpm: float = param(9, min=0, doc="Rotor turns per minute.")

    def update(self, ctx, dt):
        self.entity.get(Model).pose("rotor", (ctx.time.now * self.rpm * 6) % 360)
