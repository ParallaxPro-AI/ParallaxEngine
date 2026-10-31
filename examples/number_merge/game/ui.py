"""Panels: title, pause, HUD and result. Every button is a built-in panel command,
and each panel opens on its own: by the scene, by a key, or by following `Score`.
Pause and result exist only on the board (`scenes=`)."""

from parallax import Panel, SettingsPanel, close_panel, load_scene, open_panel, reload_scene, ui
from project import Scenes, Text

from game.actions import Controls
from game.config import Rules
from game.resources import Outcome, Records, Score


@ui("title_screen", html="ui/title.html", layer="menu")
class TitleScreen(Panel):
    actions = {"play": load_scene(Scenes.board, new_run=True)}

    def state(self, ctx):
        records = ctx.get(Records)
        return {"best_score": records.best_score, "best_tile": records.best_tile,
                "has_best": records.best_score > 0, "has_best_tile": records.best_tile > 0,
                "target": ctx.config(Rules).target}


@ui("pause_menu", html="ui/pause.html", modal=True, layer="menu", scenes=[Scenes.board],
    toggle_with=Controls.pause)
class PauseMenu(Panel):
    actions = {"resume": close_panel(), "quit": load_scene(Scenes.title),
               "settings": open_panel(SettingsPanel)}


@ui("hud", html="ui/hud.html")
class Hud(Panel):
    def state(self, ctx):
        score = ctx.get(Score)
        target = ctx.config(Rules).target
        ladder = min(1.0, score.highest / target)
        return {
            "score": score.points,
            # Alternating classes restart the bump animation on every scoring slide.
            "bump_a": score.scored_slides > 0 and score.scored_slides % 2 == 0,
            "bump_b": score.scored_slides % 2 == 1,
            "best": ctx.get(Records).best_score,
            "highest": score.highest,
            "ladder": f"{ladder * 100:.1f}%",
            "ladder_done": ladder >= 1,
            "target": target,
        }


@ui("result_panel", html="ui/result.html", modal=True, layer="menu", scenes=[Scenes.board],
    when=lambda ctx: ctx.get(Score).outcome is not Outcome.PLAYING,
    delay=lambda ctx: ctx.config(Rules).slide_seconds)
class ResultPanel(Panel):
    """Opens once the last slide has settled (the modal freezes time)."""
    actions = {"retry": reload_scene(new_run=True), "quit": load_scene(Scenes.title)}

    def state(self, ctx):
        score = ctx.get(Score)
        won = score.outcome is Outcome.WON
        target = ctx.config(Rules).target
        return {
            "won": won,
            "title": ctx.text(Text.won_title, target=target) if won else ctx.text(Text.lost_title),
            "subtitle": ctx.text(Text.won_subtitle, target=target) if won else ctx.text(Text.lost_subtitle),
            "score": score.points,
            "best": ctx.get(Records).best_score,
            "new_best": score.points > score.best_before,
            "highest": score.highest,
        }
