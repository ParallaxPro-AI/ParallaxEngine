"""The panels. Two buttons run game code directly (choosing an opponent, picking
a promotion piece) and Resign tells the referee; everything else is a built-in
command, and the promotion picker and result card follow state."""

from parallax import ContentRef, Panel, Settings, TextRef, close_panel, load_scene, open_panel, reload_scene, ui
from project import Scenes, Text

from game.actions import Controls
from game.board import COMPUTER, HUMAN, in_play, position
from game.chess.evaluate import material
from game.chess.position import color_of
from game.chess.status import Ending
from game.config import Evaluation
from game.content import DifficultyDef
from game.events import MoveChosen, Resigned
from game.resources import Match, Record, Selection, Session

GLYPHS = {"p": "♟", "n": "♞", "b": "♝", "r": "♜", "q": "♛", "k": "♚"}
OUTLINE = {"p": "♙", "n": "♘", "b": "♗", "r": "♖", "q": "♕", "k": "♔"}
TEXT_STYLE = "\ufe0e"  # draw the glyph as text, never as an emoji
BANNER_SECONDS = 2.0
QUALITIES = ("low", "medium", "high")

ENDING_WORD = {Ending.CHECKMATE: "Checkmate", Ending.STALEMATE: "Stalemate", Ending.RESIGNATION: "Resigned"}

RESULT_TEXT = {HUMAN: Text.result_win, COMPUTER: Text.result_loss, "": Text.result_draw}

ENDING_TEXT = {
    Ending.STALEMATE: Text.ending_stalemate,
    Ending.INSUFFICIENT_MATERIAL: Text.ending_insufficient_material,
    Ending.FIFTY_MOVES: Text.ending_fifty_moves,
    Ending.REPETITION: Text.ending_repetition,
    Ending.RESIGNATION: Text.ending_resignation,
}


def choose_opponent(ctx, difficulty: ContentRef[DifficultyDef]) -> None:
    """A title-screen opponent button: remember the choice, set up the board."""
    ctx.get(Session).difficulty = difficulty
    ctx.scenes.load(Scenes.board)


def promote(ctx, piece: str) -> None:
    """A promotion-picker button (`data-piece="q"`): finish the waiting pawn move.
    Clearing `Selection.promotion` closes the picker."""
    selection = ctx.get(Selection)
    ctx.emit(MoveChosen(move=selection.promotion + piece))
    selection.promotion = None


def set_quality(ctx, quality: str) -> None:
    """The pause card's Graphics Low / Medium / High (the template's own settings view)."""
    if quality in QUALITIES:
        ctx.get(Settings).quality = quality


@ui("title", html="ui/title.html", modal=True, layer="menu")
class TitleScreen(Panel):
    actions = {"choose": choose_opponent}

    def state(self, ctx):
        record = ctx.get(Record)
        return {
            "record": ctx.text(Text.record, wins=record.wins, losses=record.losses, draws=record.draws),
            "wins": record.wins,
            "losses": record.losses,
            "draws": record.draws,
            "wins_label": "Win" if record.wins == 1 else "Wins",
            "losses_label": "Loss" if record.losses == 1 else "Losses",
            "draws_label": "Draw" if record.draws == 1 else "Draws",
            "difficulties": [
                {"difficulty": ref.id, "name": ctx.text(ref.data.name), "blurb": ctx.text(ref.data.blurb),
                 "two": rank >= 1, "three": rank >= 2}
                for rank, ref in enumerate(ctx.content(DifficultyDef))
            ],
        }


@ui("pause", html="ui/pause.html", modal=True, layer="menu", scenes=[Scenes.board], toggle_with=Controls.pause)
class PauseMenu(Panel):
    actions = {"resume": close_panel(), "quality": set_quality, "quit": load_scene(Scenes.title)}

    def state(self, ctx):
        quality = ctx.get(Settings).quality
        return {f"quality_{q}": "true" if quality == q else "false" for q in QUALITIES}


@ui("hud", html="ui/hud.html")
class Hud(Panel):
    actions = {"resign": Resigned, "pause": open_panel(PauseMenu)}

    def state(self, ctx):
        match = ctx.get(Match)
        now = position(ctx)
        values = ctx.config(Evaluation).piece_values
        advantage = (material(now.board, HUMAN, values) - material(now.board, COMPUTER, values)) // 100
        over = not in_play(ctx)
        by_you = _glyphs(match.captured, COMPUTER, GLYPHS)
        return {
            "turn_state": "over" if over else ("you" if now.turn == HUMAN else "thinking"),
            "turn": "Game over" if over else ctx.text(Text.turn_yours if now.turn == HUMAN else Text.turn_theirs),
            "over": over,
            "difficulty": ctx.text(ctx.get(Session).difficulty.data.name),
            "advantage": f"+{advantage}" if advantage > 0 else (f"\u2212{-advantage}" if advantage else ctx.text(Text.material_even)),
            "advantage_tone": "pos" if advantage > 0 else ("neg" if advantage < 0 else "even"),
            "taken_by_you": by_you or "—",
            "none_by_you": not by_you,
            "taken_by_them": _glyphs(match.captured, HUMAN, OUTLINE) or "—",
            "move_log": _move_rows(match.moves),
            "has_moves": len(match.moves) > 0,
            "banner": match.banner,
            "banner_on": match.banner != "" and ctx.time.now - match.banner_at < BANNER_SECONDS,
            "banner_tone": "accent" if match.banner == ctx.text(Text.check_them) else "danger",
        }


@ui("promotion", html="ui/promotion.html", modal=True,
    when=lambda ctx: ctx.get(Selection).promotion is not None)
class PromotionPicker(Panel):
    actions = {"choose": promote}

    def state(self, ctx):
        target = ctx.get(Selection).promotion[2:4]
        return {"where": f"Pawn reaches {target}"}


@ui("game_over", html="ui/game_over.html", modal=True, layer="menu",
    when=lambda ctx: not in_play(ctx), delay=0.6)
class GameOver(Panel):
    """Waits 0.6 s after the deciding move: the card is modal, and a modal freezes
    time, which would stop the mating piece mid-slide."""
    actions = {"play_again": reload_scene(), "quit": load_scene(Scenes.title)}

    def state(self, ctx):
        match = ctx.get(Match)
        return {
            "result": "win" if match.winner == HUMAN else ("loss" if match.winner == COMPUTER else "draw"),
            "title": ctx.text(RESULT_TEXT[match.winner]),
            "ending": ENDING_WORD.get(match.ending, "Draw"),
            "reason": ctx.text(_reason(match)),
            "moves": position(ctx).fullmove,
            "difficulty": ctx.text(ctx.get(Session).difficulty.data.name),
        }


def _reason(match: Match) -> TextRef:
    if match.ending is Ending.CHECKMATE:
        return Text.ending_checkmate_win if match.winner == HUMAN else Text.ending_checkmate_loss
    return ENDING_TEXT[match.ending]


def _glyphs(captured: list[str], color: str, glyphs: dict[str, str]) -> str:
    return " ".join(glyphs[piece.lower()] + TEXT_STYLE for piece in captured if color_of(piece) == color)


def _move_rows(moves: list[str]) -> list[dict]:
    """One row per full move: `{"number": "12.", "white": "Nf3", "black": "Nc6"}`; the
    newest move is marked like the template's log."""
    last = len(moves) - 1
    return [
        {"number": f"{ply // 2 + 1}.", "white": moves[ply], "black": moves[ply + 1] if ply + 1 < len(moves) else "",
         "white_last": ply == last, "black_last": ply + 1 == last}
        for ply in range(0, len(moves), 2)
    ]
