from parallax import Behavior, behavior, clamp
from parallax.physics import Rigidbody
from parallax.vehicles import Vehicle

from game.actions import TankControls
from game.config import BattleRules


@behavior("tank_drive", requires=[Vehicle, Rigidbody])
class TankDrive(Behavior):
    """The player's tracks: the stick's y is throttle, its x pivots the hull, Space
    brakes. The hull can't leave the battlefield."""

    def fixed_update(self, ctx, dt):
        stick = ctx.input.axis(TankControls.drive)
        brake = 1.0 if ctx.input.held(TankControls.brake) else 0.0
        self.entity.get(Vehicle).drive(throttle=stick.y, steer=stick.x, brake=brake)

        edge = ctx.config(BattleRules).map_half
        position = self.entity.transform.position
        inside = position.with_x(clamp(position.x, -edge, edge)).with_z(clamp(position.z, -edge, edge))
        if inside != position:
            self.entity.get(Rigidbody).teleport(inside, keep_velocity=True)
