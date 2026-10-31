"""Panels: title, pause, HUD and shift result. Pause and result exist only in the
yard (`scenes=`); Play/Continue, the graphics switch and the HUD's Undo, Redo and Reset
are plain functions."""

from typing import Literal

from parallax import Context, Panel, Settings, close_panel, load_scene, open_panel, ui
from project import Scenes, Text

from game.actions import Controls
from game.level import current_level, level_count, yard_of
from game.resources import Attempt, Records, Shift
from game.systems.yard import redo, reset, undo


def play(ctx: Context) -> None:
    """Play from level 1, or Continue from the saved resume point (a resumed shift
    can't set the fewest-moves record)."""
    level = ctx.get(Records).resume_level
    ctx.scenes.load(Scenes.yard, new_run=True, init=[Shift(level_index=level, started_at=level)])


def new_game(ctx: Context) -> None:
    """Forget the resume point and start the shift at level 1."""
    ctx.get(Records).resume_level = 0
    ctx.scenes.load(Scenes.yard, new_run=True)


def set_quality(ctx: Context, quality: Literal["low", "medium", "high"]) -> None:
    ctx.get(Settings).quality = quality


@ui("title_screen", html="ui/title.html", layer="menu")
class TitleScreen(Panel):
    actions = {"play": play, "new_game": new_game}

    def state(self, ctx):
        records = ctx.get(Records)
        levels = level_count(ctx)
        resume = records.resume_level
        return {
            "has_save": resume > 0,
            "play_label": ctx.text(Text.continue_label if resume > 0 else Text.play),
            "resume_level": resume + 1,
            "levels": levels,
            "resume_progress": (resume + 1) / levels,
            "resume_width": f"{min(100, round((resume + 1) / levels * 100))}%",
            "no_save": resume == 0,
            "no_rows": resume == 0 and records.best_moves == 0 and records.best_levels == 0,
            "has_record": records.best_moves > 0 or records.best_levels > 0,
            "record": record_line(ctx, records),
        }


def record_line(ctx: Context, records: Records) -> str:
    parts = []
    if records.best_moves > 0:
        parts.append(ctx.text(Text.best_shift, moves=records.best_moves))
    if records.best_levels > 0:
        parts.append(ctx.text(Text.levels_reached, levels=records.best_levels))
    return " · ".join(parts)


@ui("pause_menu", html="ui/pause.html", modal=True, layer="menu", scenes=[Scenes.yard],
    toggle_with=Controls.pause)
class PauseMenu(Panel):
    actions = {"resume": close_panel(), "quality": set_quality, "quit": load_scene(Scenes.title)}

    def state(self, ctx):
        quality = ctx.get(Settings).quality
        return {"low": quality == "low", "medium": quality == "medium", "high": quality == "high"}


@ui("hud", html="ui/hud.html")
class Hud(Panel):
    actions = {"undo": undo, "redo": redo, "reset": reset, "pause": open_panel(PauseMenu)}

    def state(self, ctx):
        shift = ctx.get(Shift)
        attempt = ctx.get(Attempt)
        level = current_level(ctx)
        yard = yard_of(ctx.world)
        docked = len(yard.crates & yard.pads)
        return {
            "level": shift.level_index + 1,
            "levels": level_count(ctx),
            "level_name": ctx.text(level.name),
            "level_hint": ctx.text(level.hint),
            "intro": attempt.intro,
            "odd_level": shift.level_index % 2 == 1,
            "first_level": shift.level_index == 0,
            "moves": attempt.moves,
            "pushes": attempt.pushes,
            "total": shift.total_moves,
            "crates": f"{docked}/{len(yard.crates)}",
            "all_docked": yard.solved,
            "no_undo": not attempt.history,
            "no_redo": not attempt.redo,
        }


@ui("result_panel", html="ui/result.html", modal=True, layer="menu", scenes=[Scenes.yard],
    when=lambda ctx: ctx.get(Shift).complete)
class ResultPanel(Panel):
    actions = {"retry": load_scene(Scenes.yard, new_run=True), "quit": load_scene(Scenes.title)}

    def state(self, ctx):
        shift = ctx.get(Shift)
        best = ctx.get(Records).best_moves
        return {
            "subtitle": ctx.text(Text.shift_subtitle, levels=level_count(ctx), moves=shift.total_moves),
            "moves": shift.total_moves,
            "best": best if best else "—",
            "new_best": shift.new_record,
            "beat_previous": shift.new_record and shift.previous_best > 0,
            "previous_best": shift.previous_best,
            "resumed": shift.started_at > 0,
        }
