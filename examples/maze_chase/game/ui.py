"""Panels, styled with the template's Neon Warren kit (`ui/kit.css`). The title card sits
over the frozen maze; the HUD follows the run in the maze; pause exists only there; the
result card follows state. The graphics switch is a plain function."""

from typing import Literal

from parallax import Context, Panel, Settings, close_panel, load_scene, open_panel, reload_scene, ui
from project import Scenes, Text

from game.actions import Controls
from game.config import PaceTuning, Rules
from game.content import LevelDef, StalkerDef
from game.progress import current_level, getting_ready, lives_left, run_over
from game.resources import Best, Board, Hunt, Pace, Run

FRIGHT_ENDING = 1.6
"""Seconds left on a flare when the HUD's fright badge starts flashing fast."""


def set_quality(ctx: Context, quality: Literal["low", "medium", "high"]) -> None:
    ctx.get(Settings).quality = quality


@ui("title_screen", html="ui/title.html", modal=True, layer="menu")
class TitleScreen(Panel):
    actions = {"start": load_scene(Scenes.maze, new_run=True)}

    def state(self, ctx):
        best = ctx.get(Best)
        return {
            "has_best": best.score > 0,
            "best_score": f"{best.score:,}",
            "has_level": best.level > 0,
            "best_level": ctx.text(Text.deepest_level, number=best.level, total=len(ctx.content(LevelDef))),
            "stalkers": [
                {"name": ctx.text(s.data.name), "style": ctx.text(s.data.style), "id": s.id}
                for s in ctx.content(StalkerDef)
            ],
        }


@ui("pause_menu", html="ui/pause.html", modal=True, layer="menu", scenes=[Scenes.maze],
    toggle_with=Controls.pause)
class PauseMenu(Panel):
    actions = {"resume": close_panel(), "quality": set_quality, "quit": load_scene(Scenes.title)}

    def state(self, ctx):
        quality = ctx.get(Settings).quality
        return {"low": quality == "low", "medium": quality == "medium", "high": quality == "high"}


@ui("hud", html="ui/hud.html", scenes=[Scenes.maze], when=lambda ctx: not run_over(ctx))
class Hud(Panel):
    actions = {"pause": open_panel(PauseMenu)}

    def state(self, ctx):
        run = ctx.get(Run)
        fright = ctx.get(Hunt).fright
        levels = len(ctx.content(LevelDef))
        number = run.level_index + 1
        name = ctx.text(current_level(ctx).name)
        lives = ctx.config(Rules).lives
        return {
            "score": f"{run.score:,}",
            "best": f"{max(ctx.get(Best).score, run.score):,}",
            "pips": ctx.get(Board).pips_left,
            "level": number,
            "levels": levels,
            "level_name": name,
            "depth": [{"done": i < number, "now": i == number} for i in range(1, levels + 1)],
            "lives": [{"lost": i >= lives_left(ctx)} for i in range(lives)],
            "pace": ctx.text(pace_label(ctx)),
            "frightened": not fright.done,
            "ending": not fright.done and fright.remaining < FRIGHT_ENDING,
            "fright_width": f"{(1 - fright.progress) * 100:.1f}%" if not fright.done else "0%",
            "fright_time": f"{fright.remaining:.1f}s" if not fright.done else "",
            "ready": getting_ready(ctx),
            "ready_line": ctx.text(Text.ready_line, number=number, name=name),
        }


@ui("result", html="ui/result.html", modal=True, layer="menu", when=run_over)
class ResultPanel(Panel):
    actions = {"retry": reload_scene(new_run=True), "quit": load_scene(Scenes.title)}

    def state(self, ctx):
        run = ctx.get(Run)
        total = len(ctx.content(LevelDef))
        return {
            "won": run.won,
            "lost": not run.won,
            "title": ctx.text(Text.warren_cleared if run.won else Text.caught),
            "subtitle": (ctx.text(Text.all_levels_cleared, total=total) if run.won
                         else ctx.text(Text.out_of_lives, number=run.level_index + 1, total=total)),
            "score": f"{run.score:,}",
            "best": f"{ctx.get(Best).score:,}",
            "new_best": run.new_best,
        }


def pace_label(ctx):
    level = ctx.get(Pace).level
    tuning = ctx.config(PaceTuning)
    if level < tuning.eased_below:
        return Text.pace_eased
    if level > tuning.hot_above:
        return Text.pace_hot
    return Text.pace_steady
