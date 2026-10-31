from parallax import Behavior, behavior, clamp, param

from game.actions import Controls
from game.components import Smash
from game.resources import Duel, Mods


@behavior("player_paddle", requires=[Smash])
class PlayerPaddle(Behavior):
    """Moves the player's paddle up and down the court. Holding Smash during a rally
    loads a charge, and the paddle crawls while it does: power for position."""

    speed: float = param(12.0, unit="m/s")
    reach: float = param(5.5, unit="m", doc="Furthest the paddle's centre travels from the middle.")
    charge_time: float = param(0.7, unit="s", doc="Seconds to charge fully.")
    charge_slow: float = param(0.55, min=0, max=1, doc="Speed multiplier while charging.")

    def update(self, ctx, dt):
        mods = ctx.get(Mods)
        charging = self.charge(ctx, dt)
        slow = self.charge_slow if charging else 1.0

        tf = self.entity.transform
        tf.scale = tf.scale.with_z(mods.paddle_length)
        # Up on the stick is up the screen: +z (the engine is left-handed, +z forward).
        z = tf.position.z + ctx.input.value(Controls.move) * self.speed * mods.paddle_speed * slow * dt
        tf.position = tf.position.with_z(clamp(z, -self.reach, self.reach))

    def charge(self, ctx, dt) -> bool:
        """Builds the charge while Smash is held in a rally, bleeds it off otherwise.
        Returns whether the paddle is currently loading a smash."""
        smash = self.entity.get(Smash)
        rate = ctx.get(Mods).charge_rate / self.charge_time
        holding = ctx.input.held(Controls.smash) and not ctx.get(Duel).serving
        if holding:
            smash.charge = min(1.0, smash.charge + rate * dt)
        else:
            smash.charge = max(0.0, smash.charge - 2 * rate * dt)
        return holding and smash.charge > 0
