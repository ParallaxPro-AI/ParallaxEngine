"""Panels, ported from the template's broadcast kit. The HUD and title are listed by the
stadium scene; the rest follow game state."""

import math

from parallax import Panel, Settings, close_panel, open_panel, reload_scene, ui
from project import Text

from game.actions import Controls
from game.components import Footballer, Stamina
from game.content import CupRules
from game.resources import Career, Cup, Match, Result
from game.rules import opponent
from game.training import pick

KEYS_HINT_SECONDS = 20
"""The desktop keycap row (and the touch sprint hint) shows for the first 20 s of a run."""


def clock_text(seconds: float) -> str:
    whole = max(0, math.ceil(seconds))
    return f"{whole // 60}:{whole % 60:02d}"


def abbr(name: str) -> str:
    """'Halcyon FC' -> 'HAL', as the scorebug shortens names on a phone."""
    return "".join(c for c in name if c.isalpha())[:3].upper()


def score_text(match: Match) -> str:
    return f"{match.home_goals} – {match.away_goals}"


def round_pips(ctx, *, out: bool = False, gold: bool = False) -> list[dict]:
    """One pip per round: cleared, this one (or the one the run fell at) and still ahead."""
    now = ctx.get(Cup).round
    return [
        {"done": i < now and not gold, "now": i == now and not out and not gold,
         "out": i == now and out, "gold": gold}
        for i in range(len(ctx.config(CupRules).rounds))
    ]


def set_quality(ctx, value: str):
    """The pause card's graphics switch."""
    ctx.get(Settings).quality = value


@ui("pause_menu", html="ui/pause.html", modal=True, layer="menu", toggle_with=Controls.pause)
class PauseMenu(Panel):
    """PAUSED with the tie's context, Resume / Main Menu and the Low / Medium / High switch."""

    actions = {"resume": close_panel(), "main_menu": reload_scene(new_run=True), "quality": set_quality}

    def state(self, ctx):
        match = ctx.get(Match)
        stage = ctx.text(opponent(ctx).stage)
        current = ctx.get(Settings).quality
        return {
            "context": f"{stage} · {score_text(match)} · {clock_text(match.clock)}",
            "stage": stage,
            "score": score_text(match),
            "clock": clock_text(match.clock),
            "qualities": [
                {"value": q, "label": ctx.text(label), "checked": "true" if q == current else "false"}
                for q, label in (("low", Text.quality_low), ("medium", Text.quality_medium), ("high", Text.quality_high))
            ],
        }


@ui("hud", html="ui/hud.html")
class Hud(Panel):
    """The slanted scorebug with the cup chip, and the card of the player you control."""

    actions = {"pause": open_panel(PauseMenu)}

    def state(self, ctx):
        match = ctx.get(Match)
        cup = ctx.config(CupRules)
        foe = opponent(ctx)
        player = match.controlled
        stamina = player.get(Stamina)
        footballer = player.get(Footballer)
        level = stamina.current / stamina.max
        return {
            "on_title": ctx.ui.is_open(TitleScreen),
            "club": ctx.text(cup.club),
            "club_abbr": abbr(ctx.text(cup.club)),
            "opponent": ctx.text(foe.name),
            "opponent_abbr": abbr(ctx.text(foe.name)),
            "away_key": foe.kit,
            "home_goals": match.home_goals,
            "away_goals": match.away_goals,
            "clock": clock_text(match.clock),
            "period": ctx.text(Text.golden_short) if match.golden else ctx.text(Text.half_short, half=match.half),
            "period_key": "GG" if match.golden else f"H{match.half}",
            "stage": ctx.text(foe.stage),
            "pips": round_pips(ctx),
            "round": ctx.get(Cup).round + 1,
            "rounds": len(cup.rounds),
            "number": footballer.number,
            "pos": ctx.text(footballer.short) if footballer.short else "",
            "position": ctx.text(footballer.position) if footballer.position else "",
            "stamina": f"{level:.3f}",
            "stamina_value": round(stamina.current),
            "stamina_level": "crit" if level < 0.25 else "low" if level <= 0.5 else "ok",
            "show_keys": ctx.time.scene_time < KEYS_HINT_SECONDS,
        }


@ui("title_screen", html="ui/title.html", modal=True, layer="menu")
class TitleScreen(Panel):
    """A modal over the frozen pitch: closing it starts the first kickoff countdown."""

    actions = {"kick_off": close_panel()}

    def state(self, ctx):
        return {"cups_won": ctx.get(Career).cups_won}


@ui("team_talk", html="ui/team_talk.html", modal=True, layer="menu",
    when=lambda ctx: bool(ctx.get(Cup).offers))
class TeamTalk(Panel):
    """Between rounds: pick one training card to take into the next tie."""

    actions = {"pick": pick}

    def state(self, ctx):
        cup = ctx.get(Cup)
        rules = ctx.config(CupRules)
        upcoming = rules.rounds[cup.round + 1].data
        return {
            "won_stage": ctx.text(opponent(ctx).stage),
            "pips": round_pips(ctx),
            "round": cup.round + 1,
            "rounds": len(rules.rounds),
            "score": score_text(ctx.get(Match)),
            "next_away": upcoming.kit,
            "next_stage": ctx.text(upcoming.stage),
            "next_opponent": ctx.text(upcoming.name),
            "scout_report": ctx.text(upcoming.scout_report),
            "squad": [{"name": ctx.text(card.data.name)} for card in cup.training],
            "cards": [
                {"card": card.id, "number": i + 1, "name": ctx.text(card.data.name),
                 "description": ctx.text(card.data.description)}
                for i, card in enumerate(cup.offers)
            ],
        }


@ui("full_time", html="ui/full_time.html", modal=True, layer="menu",
    when=lambda ctx: ctx.get(Cup).result is not Result.UNDECIDED)
class FullTime(Panel):
    """The end of the run: champions (trophy, gold tape) or knocked out in some round."""

    actions = {"play_again": reload_scene(new_run=True), "main_menu": reload_scene(new_run=True)}

    def state(self, ctx):
        cup, match = ctx.get(Cup), ctx.get(Match)
        rules = ctx.config(CupRules)
        foe = opponent(ctx)
        champions = cup.result is Result.CHAMPIONS
        cleared = cup.round + (1 if champions else 0)
        where = (ctx.text(Text.champions) if champions
                 else ctx.text(Text.round_of, round=cup.round + 1, rounds=len(rules.rounds)))
        if champions:
            stats = [(Text.rounds_cleared, str(cleared), True), (Text.final, score_text(match), False),
                     (Text.shots, str(cup.shots), False), (Text.saves, str(cup.saves), False),
                     (Text.turnovers, str(cup.turnovers), False)]
        else:
            stats = [(Text.rounds_cleared, str(cleared), False), (Text.fell_at, ctx.text(foe.stage), True),
                     (Text.score, score_text(match), False), (Text.shots, str(cup.shots), False),
                     (Text.turnovers, str(cup.turnovers), False)]
        return {
            "champions": champions,
            "away_key": foe.kit,
            "title": ctx.text(Text.cup_won if champions else Text.knocked_out),
            "meta": ctx.text(Text.full_time_meta, cup=ctx.text(rules.name), where=where),
            "pips": round_pips(ctx, out=not champions, gold=champions),
            "club": ctx.text(rules.club),
            "opponent": ctx.text(foe.name),
            "score": score_text(match),
            "stats": [{"label": ctx.text(label), "value": value, "highlight": hl} for label, value, hl in stats],
            "cups_won": ctx.get(Career).cups_won,
        }
