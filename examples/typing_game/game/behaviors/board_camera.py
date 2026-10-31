from parallax import Behavior, behavior, param, rad, state, vec3
from math import cos, sin

from game.actions import BoardControls


@behavior("board_camera")
class BoardCamera(Behavior):
    """Looks down at the board's centre from `height` meters along a `tilt`-degree
    line; dragging with the right mouse button swings it around (yaw)."""

    height: float = param(19.0, unit="m")
    tilt: float = param(40.0, doc="Degrees above the board.")
    center_x: float = param(0.0, unit="m")
    center_z: float = param(-12.0, unit="m")
    turn_rate: float = param(0.3, doc="Degrees of yaw per pixel dragged.")
    yaw: float = state(0.0)

    def update(self, ctx, dt):
        if ctx.input.held(BoardControls.orbit):
            self.yaw -= ctx.input.axis(BoardControls.look).x * self.turn_rate
        tilt, yaw = rad(self.tilt), rad(self.yaw)
        reach = cos(tilt) * self.height
        self.entity.transform.position = vec3(self.center_x + sin(yaw) * reach, sin(tilt) * self.height,
                                              self.center_z + cos(yaw) * reach)
        self.entity.transform.look_at(vec3(self.center_x, 0, self.center_z))
