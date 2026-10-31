from parallax import Behavior, behavior, param, state, vec3

from game.actions import SiegeControls
from game.resources import View


@behavior("overview_camera")
class OverviewCamera(Behavior):
    """The template's bounded, eased view of the whole diorama: it looks down at a point
    on the board from `height` up and `offset` back, WASD / arrows slide that point
    around, and Home (or the HUD's Recenter) brings it back to the middle."""

    height: float = param(43.0, unit="m")
    offset: float = param(30.0, unit="m", doc="How far behind the look point the camera sits.")
    pan_speed: float = param(14.0, unit="m/s")
    reach_x: float = param(9.0, unit="m")
    reach_z: float = param(7.0, unit="m")

    look_x: float = state(0.0)
    look_z: float = state(0.0)

    def update(self, ctx, dt):
        view = ctx.get(View)
        if ctx.input.pressed(SiegeControls.recenter):
            recenter(ctx)
        pan = ctx.input.axis(SiegeControls.pan)
        view.target_x = max(-self.reach_x, min(self.reach_x, view.target_x + pan.x * self.pan_speed * dt))
        view.target_z = max(-self.reach_z, min(self.reach_z, view.target_z + pan.y * self.pan_speed * dt))
        ease = min(1.0, dt * 9)
        self.look_x += (view.target_x - self.look_x) * ease
        self.look_z += (view.target_z - self.look_z) * ease
        self.entity.transform.position = vec3(self.look_x, self.height, self.look_z - self.offset)
        self.entity.transform.look_at(vec3(self.look_x, 0, self.look_z))


def recenter(ctx) -> None:
    view = ctx.get(View)
    view.target_x = 0.0
    view.target_z = 0.0
