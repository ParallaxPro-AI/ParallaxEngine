"""The four panels. None needs an event class or a handler: buttons are built-in
commands, the pause menu follows its key and the result card follows `Match`."""

from parallax import Panel, SettingsPanel, close_panel, load_scene, open_panel, reload_scene, ui
from project import Scenes, Text

from game.actions import Controls
from game.board import COMPUTER, HUMAN, in_play
from game.resources import Match, Record, Result
from game.well import turn

RESULT_TEXT = {
    Result.WIN: (Text.result_win, Text.result_win_line),
    Result.LOSS: (Text.result_loss, Text.result_loss_line),
    Result.DRAW: (Text.result_draw, Text.result_draw_line),
}

# The card's four-disc line: your four, teal's four, or alternating for a draw.
RESULT_LINE = {
    Result.WIN: [HUMAN] * 4,
    Result.LOSS: [COMPUTER] * 4,
    Result.DRAW: [HUMAN, COMPUTER, HUMAN, COMPUTER],
}


@ui("title", html="ui/title.html", modal=True, layer="menu")
class TitleScreen(Panel):
    actions = {"start": load_scene(Scenes.well)}

    def state(self, ctx):
        record = ctx.get(Record)
        return {
            "wins": record.wins,
            "losses": record.losses,
            "draws": record.draws,
            "streak": record.streak,
            "best_streak": record.best_streak,
            "games": record.wins + record.losses + record.draws,
            "fresh": record.streak == 0,
            "streak_dots": [{} for _ in range(min(record.streak, 5))],
            "status": ctx.text(Text.on_a_streak, streak=record.streak) if record.streak else ctx.text(Text.ready_at_well),
        }


@ui("pause", html="ui/pause.html", modal=True, layer="menu", scenes=[Scenes.well], toggle_with=Controls.pause)
class PauseMenu(Panel):
    actions = {
        "resume": close_panel(),
        "settings": open_panel(SettingsPanel),
        "quit": load_scene(Scenes.title),
    }

    def state(self, ctx):
        cells = ctx.get(Match).cells
        return {"context": ctx.text(Text.paused_context, you=cells.count(HUMAN), them=cells.count(COMPUTER))}


@ui("hud", html="ui/hud.html")
class Hud(Panel):
    actions = {"pause": open_panel(PauseMenu)}

    def state(self, ctx):
        match = ctx.get(Match)
        over = match.result is not None
        yours = not over and turn(match.cells) is HUMAN
        return {
            "your": yours,
            "thinking": not over and not yours,
            "over": over,
            "you": match.cells.count(HUMAN),
            "them": match.cells.count(COMPUTER),
        }


@ui("game_over", html="ui/game_over.html", modal=True, layer="menu",
    when=lambda ctx: not in_play(ctx), delay=0.6)
class GameOver(Panel):
    """Waits 0.6 s after the last drop: the card is modal, and a modal freezes
    time, which would stop the winning disc mid-fall."""
    actions = {"play_again": reload_scene(), "quit": load_scene(Scenes.title)}

    def state(self, ctx):
        match = ctx.get(Match)
        title, line = RESULT_TEXT[match.result]
        record = ctx.get(Record)
        return {
            "title": ctx.text(title),
            "line_text": ctx.text(line),
            "loss": match.result is Result.LOSS,
            "draw": match.result is Result.DRAW,
            "line": [{"amber": disc is HUMAN, "teal": disc is COMPUTER} for disc in RESULT_LINE[match.result]],
            "you": match.cells.count(HUMAN),
            "them": match.cells.count(COMPUTER),
            "streak": _streak_echo(ctx, match.result, match.streak_before, record.streak),
            "streak_up": match.result is Result.WIN,
            "best_streak": record.best_streak,
        }


def _streak_echo(ctx, result: Result, before: int, now: int) -> str:
    """"Streak 3" after a win (the card adds "+1"); "Streak reset" when a loss or draw broke one."""
    if result is Result.WIN:
        return ctx.text(Text.streak_up, streak=now)
    return ctx.text(Text.streak_reset if before > 0 else Text.no_streak)
