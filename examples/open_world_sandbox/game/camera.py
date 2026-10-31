"""The one camera, framed from what the player is doing."""

from parallax import Behavior, Camera, Vec3, behavior, param

from features.driving.feature import player_car
from features.interiors.feature import InteriorZone
from features.on_foot.feature import Location
from features.phone.feature import PhotoMode


@behavior("camera_rig", requires=[Camera])
class CameraRig(Behavior):
    """Four framings, derived every frame rather than switched: an orbit on foot, a longer and higher
    orbit behind the wheel, a close orbit indoors, and first person through the phone's camera, zoomed
    by its lens. The engine's rigs do the turning; this only says which rig and how far."""

    on_foot_distance: float = param(3.8, unit="m")
    driving_distance: float = param(11, unit="m")
    shoulder_height: float = param(1.65, unit="m")
    driving_height: float = param(2.2, unit="m")
    base_fov: float = param(60, unit="deg")

    def late_update(self, ctx, dt):
        camera = self.entity.get(Camera)
        photo = ctx.get(PhotoMode)
        camera.rig = "first_person" if photo.active else "orbit"
        camera.fov = self.base_fov / photo.zoom
        distance, height = self.framing(ctx)
        camera.offset = Vec3.BACK * distance + Vec3.UP * height

    def framing(self, ctx) -> tuple[float, float]:
        """Orbit distance and height for where the player is."""
        interior = ctx.get(Location).interior
        if interior is not None:
            return interior.get(InteriorZone).camera_distance, self.shoulder_height
        if player_car(ctx) is not None:
            return self.driving_distance, self.driving_height
        return self.on_foot_distance, self.shoulder_height
