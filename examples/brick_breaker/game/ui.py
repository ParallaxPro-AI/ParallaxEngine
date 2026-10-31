"""Panels. The title and HUD are listed by their scenes; pause exists only in the arena;
the draft and game-over modals follow state."""

from parallax import Color, Panel, Settings, close_panel, load_scene, open_panel, reload_scene, ui
from project import Scenes, Text

from game.actions import Controls
from game.config import Rules
from game.content import StageDef
from game.events import UpgradePicked
from game.progress import current_stage, lives_left, run_over
from game.resources import Best, Draft, Run


def css(color: Color) -> str:
    return f"rgb({round(color.r * 255)}, {round(color.g * 255)}, {round(color.b * 255)})"


def stage_strip(ctx, *, lost: bool = False) -> list[dict]:
    """One segment per stage in its signature colour: cleared, current (or the one the
    run was lost on) and still ahead."""
    run = ctx.get(Run)
    return [
        {"color": css(stage.data.color), "done": i < run.stage_index or (i == run.stage_index and run.won),
         "now": i == run.stage_index and not run.won and not lost,
         "lost": i == run.stage_index and lost}
        for i, stage in enumerate(ctx.content(StageDef))
    ]


@ui("title_screen", html="ui/title.html", layer="menu")
class TitleScreen(Panel):
    actions = {"start": load_scene(Scenes.arena, new_run=True)}


def set_quality(ctx, value: str):
    """The pause card's graphics switch."""
    ctx.get(Settings).quality = value


@ui("pause_menu", html="ui/pause.html", modal=True, layer="menu", scenes=[Scenes.arena],
    toggle_with=Controls.pause)
class PauseMenu(Panel):
    """PAUSED, Resume / Quit Run and the template's inline Low / Medium / High graphics switch."""
    actions = {"resume": close_panel(), "quit": load_scene(Scenes.title), "quality": set_quality}

    def state(self, ctx):
        current = ctx.get(Settings).quality
        return {"qualities": [
            {"value": q, "label": ctx.text(label), "pressed": "true" if q == current else "false"}
            for q, label in (("low", Text.quality_low), ("medium", Text.quality_medium), ("high", Text.quality_high))
        ]}


@ui("hud", html="ui/hud.html")
class Hud(Panel):
    actions = {"pause": open_panel(PauseMenu)}

    def state(self, ctx):
        run = ctx.get(Run)
        owned = ctx.get(Draft).owned
        orbs = lives_left(ctx)
        return {
            "score": run.score,
            "best": max(ctx.get(Best).score, run.score),
            "combo": run.combo,
            "combo_zero": run.combo == 0,
            "stage": f"{run.stage_index + 1}/{len(ctx.content(StageDef))}",
            "stage_name": ctx.text(current_stage(ctx).name),
            "stage_color": css(current_stage(ctx).color),
            "segments": stage_strip(ctx),
            "bricks_left": run.bricks_left,
            "orbs": orbs,
            "pips": [{"empty": i >= orbs} for i in range(max(ctx.config(Rules).lives, orbs))],
            "upgrades": " · ".join(ctx.text(u.data.name) for u in owned) or ctx.text(Text.no_upgrades),
            "no_upgrades": not owned,
            "upgrade_count": len(owned),
            "serving": run.serving,
        }


@ui("draft", html="ui/draft.html", modal=True, layer="menu",
    when=lambda ctx: bool(ctx.get(Draft).offer))
class DraftPanel(Panel):
    actions = {"pick": UpgradePicked}

    def state(self, ctx):
        run = ctx.get(Run)
        upcoming = ctx.content(StageDef)[run.stage_index + 1].data
        return {
            "cleared": ctx.text(Text.stage_cleared, number=run.stage_index + 1),
            "score": run.score,
            "next_stage": ctx.text(upcoming.name),
            "next_tagline": ctx.text(upcoming.tagline),
            "next_color": css(upcoming.color),
            "cards": [
                {"upgrade": u.id, "number": i + 1, "name": ctx.text(u.data.name),
                 "description": ctx.text(u.data.description)}
                for i, u in enumerate(ctx.get(Draft).offer)
            ],
        }


@ui("game_over", html="ui/game_over.html", modal=True, layer="menu", when=run_over)
class GameOverPanel(Panel):
    actions = {"retry": reload_scene(new_run=True), "quit": load_scene(Scenes.title)}

    def state(self, ctx):
        run = ctx.get(Run)
        total = len(ctx.content(StageDef))
        cleared = run.stage_index + 1 if run.won else run.stage_index
        return {
            "won": run.won,
            "outcome": "victory" if run.won else "defeat",
            "stage_name": ctx.text(current_stage(ctx).name),
            "stage_color": css(current_stage(ctx).color),
            "segments": stage_strip(ctx, lost=not run.won),
            "score": run.score,
            "best": ctx.get(Best).score,
            "new_best": run.new_best,
            "stages_cleared": f"{cleared}/{total}",
            "upgrades": len(ctx.get(Draft).owned),
            "orbs_left": lives_left(ctx),
        }
