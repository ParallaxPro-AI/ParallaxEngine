import math

from parallax import Behavior, Camera, Vec3, behavior, param, state, vec3
from project import Placed

from game.components import Phase, Throw
from game.darts import on_face


@behavior("oche_view", requires=[Camera])
class OcheView(Behavior):
    """The darts camera. Stands at the oche looking down the throw, drifts a
    little toward the reticle so an edge aim stays in frame, and watches the dart
    while it flies. No mouse-look, so the cursor stays free for the HUD."""

    settle: float = param(8.0, doc="Exponential smoothing rate (1/s).")
    nudge: float = param(0.22, doc="How far the camera leans with the reticle.")
    look_lead: float = param(0.6, doc="How far the gaze leads toward the reticle.")

    home: Vec3 = state(Vec3.ZERO)

    def start(self, ctx):
        self.home = self.entity.transform.position

    def late_update(self, ctx, dt):
        dart = ctx.world.placed(Placed.dart)
        throw = dart.get(Throw)
        board = ctx.world.placed(Placed.board).transform.position
        face = on_face(throw.aim)
        lean = vec3(face.x * self.nudge, face.y * self.nudge * 0.5, 0)
        transform = self.entity.transform
        transform.position = transform.position.lerp(self.home + lean, 1 - math.exp(-self.settle * dt))
        if throw.phase is Phase.FLYING:
            transform.look_at(dart.transform.position)
        else:
            transform.look_at(board + on_face(throw.aim) * self.look_lead)
