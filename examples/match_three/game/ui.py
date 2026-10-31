"""Panels, ported from the template's jewel-box UI (`ui/gem_kit.css`): title, board HUD,
pause, relic draft and run result. Menu buttons are built-in panel commands or plain
functions; the HUD, the draft and the result follow the run, and only on the board."""

from typing import Literal

from parallax import ContentRef, Context, Panel, Settings, close_panel, load_scene, open_panel, reload_scene, ui
from project import Scenes, Text

from game.actions import Controls
from game.board import show_hint
from game.components import Crust
from game.config import Rules
from game.content import RelicDef, StageDef
from game.descent import current_stage, stage_count
from game.events import RelicPicked
from game.resources import BoardState, Outcome, Records, Run


def grouped(points: int) -> str:
    return f"{points:,}"


def moves_word(ctx: Context, moves: int) -> str:
    return ctx.text(Text.move if moves == 1 else Text.moves)


def relic_chips(ctx: Context) -> list[dict[str, str]]:
    """One chip per carried relic; its id picks the glyph and colour in gem_kit.css."""
    return [{"id": relic.id, "name": ctx.text(relic.data.name)} for relic in ctx.get(Run).relics]


def lit(text: str, phrase: str) -> dict[str, str]:
    """A description split around the phrase the draft card lights."""
    at = text.find(phrase)
    if at < 0:
        return {"before": text, "lit": "", "after": ""}
    return {"before": text[:at], "lit": phrase, "after": text[at + len(phrase):]}


def relic_card(ctx: Context, ref: ContentRef[RelicDef]) -> dict[str, object]:
    """A draft card; clicking it sends `pick` with the card's `relic` id."""
    relic = ref.data
    phrase = ctx.text(relic.highlight)
    return {
        "relic": ref.id,
        "name": ctx.text(relic.name),
        "desc": lit(ctx.text(relic.description), phrase),
        "short": lit(ctx.text(relic.short), phrase),
    }


def drafting(ctx: Context) -> bool:
    return len(ctx.get(Run).offer) > 0


def run_over(ctx: Context) -> bool:
    return ctx.get(Run).outcome is not Outcome.PLAYING


def set_quality(ctx: Context, quality: Literal["low", "medium", "high"]) -> None:
    ctx.get(Settings).quality = quality


@ui("title_screen", html="ui/title.html", layer="menu")
class TitleScreen(Panel):
    actions = {"play": load_scene(Scenes.board, new_run=True)}

    def state(self, ctx):
        records = ctx.get(Records)
        return {
            "has_record": records.best_run > 0 or records.best_stage > 0,
            "has_stage": records.best_stage > 0,
            "best_run": grouped(records.best_run),
            "best_stage": records.best_stage,
            "stages": stage_count(ctx),
        }


@ui("pause_menu", html="ui/pause.html", modal=True, layer="menu", scenes=[Scenes.board],
    toggle_with=Controls.pause)
class PauseMenu(Panel):
    actions = {"resume": close_panel(), "quality": set_quality, "quit": load_scene(Scenes.title)}

    def state(self, ctx):
        run = ctx.get(Run)
        quality = ctx.get(Settings).quality
        return {
            "stage": run.stage_index + 1,
            "stages": stage_count(ctx),
            "stage_name": ctx.text(current_stage(ctx).name),
            "moves": run.moves_left,
            "moves_word": moves_word(ctx, run.moves_left),
            "low": quality == "low",
            "medium": quality == "medium",
            "high": quality == "high",
        }


@ui("hud", html="ui/hud.html", scenes=[Scenes.board],
    when=lambda ctx: not drafting(ctx) and not run_over(ctx) and not ctx.ui.is_open(PauseMenu))
class Hud(Panel):
    """Shown while the board is in play; the template hid it under the pause, draft and
    result cards."""
    actions = {"hint": show_hint, "pause": open_panel(PauseMenu)}

    def state(self, ctx):
        run = ctx.get(Run)
        stage = current_stage(ctx)
        crust = ctx.world.query(Crust).count()
        met = run.stage_score >= stage.target
        relics = relic_chips(ctx)
        return {
            "stage": run.stage_index + 1,
            "stages": stage_count(ctx),
            "pips": [{"on": depth < run.stage_index, "cur": depth == run.stage_index}
                     for depth in range(stage_count(ctx))],
            "stage_name": ctx.text(stage.name),
            "stage_sub": ctx.text(stage.hint),
            "score": grouped(run.stage_score),
            "target": grouped(stage.target),
            "to_go": grouped(max(0, stage.target - run.stage_score)),
            "fill": f"{min(100.0, run.stage_score / stage.target * 100):.1f}%",
            "met": met,
            "met_label": ctx.text(Text.target_met_crust, ice=crust) if crust else ctx.text(Text.stage_clear),
            "moves": run.moves_left,
            "moves_word": moves_word(ctx, run.moves_left),
            "low": run.moves_left <= ctx.config(Rules).low_moves,
            "ice": crust,
            "no_ice": crust == 0,
            "carrying": len(relics) > 0,
            "relics": relics,
            "combo": ctx.get(BoardState).chain,
            "cascade": ctx.text(Text.cascade),
            "grand_cascade": ctx.text(Text.grand_cascade),
        }


@ui("relic_draft", html="ui/relic_draft.html", modal=True, layer="menu", scenes=[Scenes.board],
    when=drafting)
class RelicDraft(Panel):
    actions = {"pick": RelicPicked}

    def state(self, ctx):
        run = ctx.get(Run)
        relics = relic_chips(ctx)
        return {
            "stage": run.stage_index + 1,
            "run_score": grouped(run.run_score),
            "carrying": len(relics) > 0,
            "relics": relics,
            "offer": [relic_card(ctx, relic) for relic in run.offer],
        }


@ui("result_panel", html="ui/result.html", modal=True, layer="menu", scenes=[Scenes.board],
    when=run_over)
class ResultPanel(Panel):
    actions = {"retry": reload_scene(new_run=True), "quit": load_scene(Scenes.title)}

    def state(self, ctx):
        run = ctx.get(Run)
        won = run.outcome is Outcome.WON
        best = ctx.get(Records).best_run
        relics = relic_chips(ctx)
        return {
            "won": won,
            "lost": not won,
            "stages": stage_count(ctx),
            "failed_stage": run.stage_index + 1,
            "failed_name": ctx.text(current_stage(ctx).name),
            "track": [
                {"name": ctx.text(stage.data.name),
                 "done": won or depth < run.stage_index,
                 "fail": not won and depth == run.stage_index}
                for depth, stage in enumerate(ctx.content(StageDef))
            ],
            "score": run.run_score,
            "best": grouped(best) if best > 0 else "—",
            "new_best": run.run_score > run.best_before,
            "carrying": len(relics) > 0,
            "relics": relics,
        }
