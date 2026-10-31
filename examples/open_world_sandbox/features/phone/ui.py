"""The phone, its buttons, and the camera viewfinder."""

from parallax import Context, ContentRef, Panel, close_panel, ui
from project import Text

from features.phone.actions import PhoneControls
from features.phone.content import ContactDef, PlaceDef
from features.phone.resources import Gallery, PhotoMode, Waypoint


def call(ctx: Context, contact: ContentRef[ContactDef]) -> None:
    """Calling a contact plays their `call` node."""
    ctx.story.say(contact.data.dialogue, node="call")


def route(ctx: Context, place: ContentRef[PlaceDef]) -> None:
    """Tapping a place routes the GPS pin there."""
    ctx.get(Waypoint).target = place
    ctx.ui.toast(ctx.text(Text.route_set, place=ctx.text(place.data.label)))


def open_camera(ctx: Context) -> None:
    """The Camera app puts the phone away and raises the viewfinder."""
    ctx.ui.close(PhonePanel)
    ctx.get(PhotoMode).active = True


@ui("phone", html="ui/phone.html", modal=True, layer="menu", toggle_with=PhoneControls.phone)
class PhonePanel(Panel):
    """Contacts, the map's named places (with the current route), and the photo gallery."""

    actions = {"call": call, "route": route, "camera": open_camera, "close": close_panel()}

    def state(self, ctx):
        routed = ctx.get(Waypoint).target
        return {
            "contacts": [
                {"contact": c.id, "name": ctx.text(c.data.name), "number": c.data.number}
                for c in ctx.content(ContactDef)
            ],
            "places": [
                {"place": p.id, "label": ctx.text(p.data.label), "glyph": p.data.glyph, "routed": p == routed}
                for p in ctx.content(PlaceDef)
            ],
            "photos": [{"src": photo.path} for photo in ctx.get(Gallery).photos],
        }


@ui("viewfinder", html="ui/viewfinder.html", layer="overlay", when=lambda ctx: ctx.get(PhotoMode).active)
class Viewfinder(Panel):
    """Frame lines, the zoom level and the shot count, exactly while photographing. Not modal: the
    world keeps moving."""

    def state(self, ctx):
        return {"zoom": round(ctx.get(PhotoMode).zoom, 1), "shots": len(ctx.get(Gallery).photos)}
