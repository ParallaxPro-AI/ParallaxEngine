from parallax import Behavior, Camera, Vec3, behavior, param

from game.rules import flown, pilot


@behavior("chase_camera", requires=[Camera])
class ChaseCamera(Behavior):
    """Orbits the pilot on foot (the mouse or right stick turns it, through `WalkControls.look`)
    and trails the plane in the air, each at its own distance. Which one is derived from the
    pilot's seat every frame; switching rigs starts the orbit behind the pilot again."""

    walk_offset: Vec3 = param(Vec3(0, 1.6, -7), doc="Orbit: pivot height above the pilot, then the arm.")
    plane_offset: Vec3 = param(Vec3(0, 6.3, -18))
    walk_pitch: float = param(-21, unit="deg", doc="The orbit's starting pitch (positive up): looking down on the pilot.")
    plane_pitch: float = param(-15, unit="deg")
    walk_smoothing: float = param(0.08, unit="s")
    plane_smoothing: float = param(0.25, unit="s")

    def late_update(self, ctx, dt):
        camera = self.entity.get(Camera)
        plane = flown(ctx)
        walker = pilot(ctx)
        camera.follow = plane or walker
        camera.rig = "follow" if plane else "orbit"
        camera.smoothing = self.plane_smoothing if plane else self.walk_smoothing
        camera.offset = self.plane_offset if plane else self.walk_offset
        camera.pitch = self.plane_pitch if plane else self.walk_pitch
