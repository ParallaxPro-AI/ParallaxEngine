"""Photo mode and the GPS pin."""

from parallax import Marker, System, system
from project import Text

from features.phone.actions import PhotoControls
from features.phone.resources import Gallery, PhotoMode, Waypoint
from features.phone.tags import GpsPin


@system("photography", when=lambda ctx: ctx.get(PhotoMode).active)
class Photography(System):
    """While the viewfinder is up: the wheel zooms, the shutter saves the frame to the gallery, Done
    puts the phone away."""

    def update(self, ctx, dt):
        mode = ctx.get(PhotoMode)
        mode.zoom = min(4.0, max(1.0, mode.zoom + ctx.input.value(PhotoControls.zoom) * 0.1))
        if ctx.input.pressed(PhotoControls.shutter):
            ctx.get(Gallery).photos.append(ctx.camera.main.capture())
            ctx.ui.toast(Text.photo_saved)
        elif ctx.input.pressed(PhotoControls.done):
            ctx.reset(PhotoMode)


@system("waypoints")
class Waypoints(System):
    """Keeps the GPS pin on the routed place's authored position (loaded or not), hidden with no route."""

    def update(self, ctx, dt):
        pin, marker = ctx.world.query(Marker, tagged=GpsPin).single()
        route = ctx.get(Waypoint).target
        marker.shown = route is not None
        if route is not None:
            pin.transform.position = ctx.world.placement(route.data.at).position
