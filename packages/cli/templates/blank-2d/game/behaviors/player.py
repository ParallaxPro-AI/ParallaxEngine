from parallax import Behavior, behavior, clamp, param

from game.actions import Controls


@behavior("player")
class Player(Behavior):
    """Moves the entity with `Controls.move`, kept inside the play area.

    `param()` fields are tunables, set per prefab in `prefabs/player.prefab.json`."""

    speed: float = param(6.0, unit="m/s")
    reach: float = param(4.5, unit="m", doc="How far from the middle the player may go, on each axis.")

    def update(self, ctx, dt):
        tf = self.entity.transform
        # In 2D, x is right and y is up; z is only draw order.
        step = ctx.input.axis(Controls.move) * self.speed * dt
        target = tf.position.xy() + step
        # Assigning a Vec2 keeps the entity's z (its draw order).
        tf.position = target.with_x(clamp(target.x, -self.reach, self.reach)).with_y(clamp(target.y, -self.reach, self.reach))
