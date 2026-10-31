"""Minimap + full map (library piece `map_screen`).

The HUD kit derives the map (static shapes and colliders, terrain, MapFeature placements,
MapIcon entities, the route). This piece restyles it twice: `MapCorner` and `MapScreen` both
subclass `MinimapPanel` (so the built-in steps aside) and bind its state — the corner map
while the map is down, the full-screen one while it is up. Whether the map is up is derived: the map key held
("hold"), or the `MapView` resource flipped by presses ("toggle"). `MapZoom` sets every
`Minimap`'s `range` and `rotate` from config for the current view each frame, so there is
nothing to restore when the map closes.

Neither panel defines `state()`: a HUD panel subclass shows the built-in's state, and
`parallax check` checks the markup against the keys `MinimapPanel` lists."""

from parallax import Actions, System, button, config, field, gamepad, resource, system, ui
from parallax.hud import Minimap, MinimapPanel

from game.lib.scene_tags import Playable


@config("map_screen")
class MapScreenConfig:
    """config/map_screen.json."""
    mode: str = field("hold", choices=["hold", "toggle"])
    corner_range: float = field(40, min=1, unit="m")
    corner_rotate: bool = field(True, doc="The corner map turns with the player.")
    map_range: float = field(250, min=1, unit="m", doc="Center to edge of the full map (always north-up).")


@resource("map_view", keep="scene")
class MapView:
    full: bool = field(False, doc="Toggle mode: the full map is up.")


class MapControls(Actions):
    scenes = [Playable]
    map = button(keyboard="KeyM", gamepad=gamepad.SELECT)


def map_up(ctx) -> bool:
    if ctx.config(MapScreenConfig).mode == "hold":
        return ctx.input.held(MapControls.map)
    return ctx.get(MapView).full


@system("map_zoom", scenes=[Playable])
class MapZoom(System):
    """Flips the toggle and zooms every minimap to the current view."""

    def update(self, ctx, dt):
        rules = ctx.config(MapScreenConfig)
        if rules.mode == "toggle" and ctx.input.pressed(MapControls.map):
            view = ctx.get(MapView)
            view.full = not view.full
        full = map_up(ctx)
        for _, minimap in ctx.world.query(Minimap):
            minimap.range = rules.map_range if full else rules.corner_range
            minimap.rotate = rules.corner_rotate and not full


@ui("map_corner", html="ui/lib/map_corner.html", scenes=[Playable], when=lambda ctx: not map_up(ctx))
class MapCorner(MinimapPanel):
    """The corner minimap (the HUD kit's state, this piece's markup)."""


@ui("map_screen", html="ui/lib/map_screen.html", layer="overlay", scenes=[Playable], when=map_up)
class MapScreen(MinimapPanel):
    """The full map, while it is up."""
