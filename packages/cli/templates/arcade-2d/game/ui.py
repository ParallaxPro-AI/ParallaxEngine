"""Panels: HTML in `ui/`, shown in the scenes that list them (`"ui": [...]` in
scene.json) or by their own `when=`. Player-facing text lives in `locale/en.json`.
`state()` returns the values the HTML binds with `data-bind`."""

from parallax import Panel, reload_scene, ui

from game.resources import Best, Run, run_over, score


@ui("hud", html="ui/hud.html")
class Hud(Panel):
    """The score and the best score."""

    def state(self, ctx):
        return {"score": score(ctx.get(Run)), "best": ctx.get(Best).score}


@ui("game_over", html="ui/game_over.html", modal=True, layer="menu", when=run_over)
class GameOver(Panel):
    """Opens by itself when the run is over (`when=`); there is no open/close code.
    Retry reloads the scene and resets every `keep="run"` resource."""
    actions = {"retry": reload_scene(new_run=True)}

    def state(self, ctx):
        return {"score": score(ctx.get(Run)), "best": ctx.get(Best).score}
