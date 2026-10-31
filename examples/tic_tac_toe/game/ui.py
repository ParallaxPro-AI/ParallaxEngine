"""The four panels. None needs an event class or a handler: buttons are built-in
commands, the pause menu follows its key and the result card follows `Match`."""

from parallax import Panel, SettingsPanel, close_panel, load_scene, open_panel, reload_scene, ui
from project import Scenes, Text

from game.actions import Controls
from game.config import Rules
from game.logic import in_play
from game.resources import Match, Record, Result
from game.rules import Mark, turn

RESULT_TEXT = {Result.WIN: Text.result_win, Result.LOSS: Text.result_loss, Result.DRAW: Text.result_draw}


@ui("title", html="ui/title.html", modal=True, layer="menu")
class TitleScreen(Panel):
    actions = {"start": load_scene(Scenes.board)}

    def state(self, ctx):
        record = ctx.get(Record)
        return {
            "record": ctx.text(Text.record_short, wins=record.wins, losses=record.losses, draws=record.draws),
            "streak": record.streak,
            "best_streak": record.best_streak,
            "hint": (ctx.text(Text.best_streak_hint, streak=record.best_streak) if record.best_streak
                     else ctx.text(Text.place_hint)),
        }


@ui("pause", html="ui/pause.html", modal=True, layer="menu", scenes=[Scenes.board], toggle_with=Controls.pause)
class PauseMenu(Panel):
    """The template's shared pause card: Resume, Main Menu and Settings (its inline
    graphics / volume / language page is the built-in SettingsPanel here)."""
    actions = {"resume": close_panel(), "quit": load_scene(Scenes.title), "settings": open_panel(SettingsPanel)}


@ui("hud", html="ui/hud.html")
class Hud(Panel):
    """Who is who, whose move it is, the opening banner and the lifetime record."""
    actions = {"pause": open_panel(PauseMenu)}

    def state(self, ctx):
        match = ctx.get(Match)
        record = ctx.get(Record)
        sun_to_move = in_play(ctx) and turn(match.cells) is Mark.SUN
        if not in_play(ctx):
            status = Text.status_over
        else:
            status = Text.status_yours if sun_to_move else Text.status_theirs
        return {
            "status": ctx.text(status),
            "yours": sun_to_move,
            "theirs": not sun_to_move,
            "banner": ctx.time.scene_time < ctx.config(Rules).banner_seconds,
            "wins": record.wins,
            "losses": record.losses,
            "draws": record.draws,
            "streak": record.streak,
        }


@ui("game_over", html="ui/game_over.html", modal=True, layer="menu",
    when=lambda ctx: not in_play(ctx), delay=0.5)
class GameOver(Panel):
    """Waits 0.5 s after the last mark: the card is modal, and a modal freezes
    time, which would stop the mark's pop-in and the win glow halfway."""
    actions = {"play_again": reload_scene(), "quit": load_scene(Scenes.title)}

    def state(self, ctx):
        result = ctx.get(Match).result
        rules = ctx.config(Rules)
        points = {Result.WIN: rules.win_points, Result.DRAW: rules.draw_points}.get(result, 0)
        record = ctx.get(Record)
        return {
            "title": ctx.text(RESULT_TEXT[result]),
            "won": result is Result.WIN,
            "lost": result is not Result.WIN,
            "score": points,
            "wins": record.wins,
            "losses": record.losses,
            "draws": record.draws,
            "streak": record.streak,
        }
