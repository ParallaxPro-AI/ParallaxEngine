"""Panels: HTML in `ui/`, shown in the scenes that list them (`"ui": [...]` in
scene.json) or by their own `when=`. Player-facing text lives in `locale/en.json`."""

from parallax import Panel, ui


@ui("hud", html="ui/hud.html")
class Hud(Panel):
    """The title and a controls hint. Static text only; add `def state(self, ctx)`
    returning a dict to bind live values with `data-bind`."""
