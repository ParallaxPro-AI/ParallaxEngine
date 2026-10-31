"""Panels, ported from the template's HTML/CSS (ui/kit.css is its kit: the --cc-* tokens,
faces and .cc-* pieces). The HUD and title are listed by the court scene; the rest follow
game state. The shot meter isn't a panel: it's a WorldBar over your head
(behaviors/shot_meter.py). The billboard over the court is a screen panel."""

import math

from parallax import Panel, Settings, TextRef, close_panel, open_panel, reload_scene, ui, vec3
from project import Text

from game.actions import Controls
from game.components import Ball, BoxScore, Edge, Flight, Home, Stamina
from game.content import Category, CourtRules
from game.ladder import pick
from game.resources import Career, Match, Phase, Result, Run
from game.rules import crew, nearest_opponent_distance, team_of, you

CATEGORY_LABELS: dict[Category, TextRef] = {
    Category.SHOOTING: Text.category_shooting,
    Category.DEFENSE: Text.category_defense,
    Category.CONDITIONING: Text.category_conditioning,
    Category.PLAYMAKING: Text.category_playmaking,
    Category.REBOUNDING: Text.category_rebounding,
}
"""Enum members have no display text of their own (see NOTES.md)."""


def css(color) -> str:
    return f"rgb({round(color.r * 255)}, {round(color.g * 255)}, {round(color.b * 255)})"


def clock_text(seconds: float) -> str:
    whole = max(0, math.ceil(seconds))
    return f"{whole // 60}:{whole % 60:02d}"


def possession(ball: Ball) -> TextRef:
    if ball.holder is None:
        return Text.loose_ball
    return Text.our_ball if ball.holder.has(Home) else Text.their_ball


QUALITIES = ("low", "medium", "high")
BANNER_SECONDS = 2.2


def set_quality(ctx, quality: str) -> None:
    """The pause card's Graphics Low / Medium / High."""
    if quality in QUALITIES:
        ctx.get(Settings).quality = quality


def leave(ctx) -> None:
    """Pause → Leave match: the run ends (a fresh run, back at the title)."""
    ctx.scenes.reload(new_run=True)


def ladder_rows(ctx, finished: bool = False) -> list[dict]:
    run = ctx.get(Run)
    rows = []
    for index, ref in enumerate(ctx.config(CourtRules).ladder):
        state = "done" if index < run.stage or (finished and index == run.stage and run.result is Result.CHAMPIONS) \
            else ("now" if index == run.stage else "up")
        rows.append({"name": ctx.text(ref.data.name), "color": css(ref.data.color), "state": state})
    return rows


def scoreboard(ctx) -> dict:
    """What the HUD scoreboard and the billboard both show."""
    match = ctx.get(Match)
    _, ball = ctx.world.query(Ball).single()
    court = ctx.config(CourtRules)
    run = ctx.get(Run)
    tonight = ctx.text(crew(ctx).name)
    shot = math.ceil(ball.shot_clock)
    intermission = match.phase is Phase.BREAK
    return {
        "stage": run.stage + 1,
        "stages": len(court.ladder),
        "home_score": match.home_score,
        "away_score": match.away_score,
        "home_color": "#f54d4d",
        "crew": tonight,
        "crew_abbr": tonight[:3].upper(),
        "crew_color": css(crew(ctx).color),
        "period": ctx.text(Text.overtime_short, number=match.overtime) if match.overtime
        else ctx.text(Text.quarter_short, number=max(1, match.quarter)),
        "regulation": match.overtime == 0,
        "quarters": court.quarters,
        "clock": clock_text(0 if intermission else match.clock),
        "intermission": intermission,
        "phase": "BREAK" if intermission else "LIVE",
        "shot_clock": "—" if intermission else shot,
        "shot_urgent": not intermission and shot <= 5,
    }


@ui("pause_menu", html="ui/pause.html", modal=True, layer="menu", toggle_with=Controls.pause)
class PauseMenu(Panel):
    actions = {"resume": close_panel(), "leave": leave, "quality": set_quality}

    def state(self, ctx):
        quality = ctx.get(Settings).quality
        state = {f"quality_{q}": "true" if quality == q else "false" for q in QUALITIES}
        state["where"] = ctx.text(Text.game_of, number=ctx.get(Run).stage + 1,
                                  total=len(ctx.config(CourtRules).ladder)).title()
        return state


@ui("court_score", html="ui/court_score.html")
class CourtScore(Panel):
    """The billboard over the court (a screen panel on the scoreboard prefab)."""

    def state(self, ctx):
        board = scoreboard(ctx)
        board["top"] = f"STAGE {board['stage']}/{board['stages']} · {board['crew']}".upper()
        board["crew_upper"] = board["crew"].upper()
        board["shot_text"] = ":--" if board["intermission"] else f":{board['shot_clock']:02d}"
        return board


@ui("hud", html="ui/hud.html", when=lambda ctx: not ctx.ui.is_open(TitleScreen))
class Hud(Panel):
    """Scoreboard, both clocks, who has the ball, and your stamina."""

    actions = {"pause": open_panel(PauseMenu)}

    def state(self, ctx):
        match = ctx.get(Match)
        _, ball = ctx.world.query(Ball).single()
        me = you(ctx)
        stamina = me.get(Stamina)
        court = ctx.config(CourtRules)
        loose = ball.holder is None
        flight = ctx.world.query(Ball, Flight).count() > 0
        carrier = ball.holder
        mate_open = carrier == me and not flight
        level = stamina.current / stamina.max
        state = scoreboard(ctx)
        state.update({
            "banner": match.banner,
            "banner_sub": match.banner_sub,
            "banner_tint": match.banner_tint,
            "banner_on": match.banner != "" and ctx.time.now - match.banner_at < BANNER_SECONDS,
            "possession": ctx.text(possession(ball)),
            "possession_state": "LOOSE" if loose else ("FLIGHT" if flight else "HOLD"),
            "loose": loose,
            "flight": flight,
            "carrier": "—" if carrier is None else ("You" if carrier == me else ("Mate" if carrier.has(Home) else "Rival")),
            "possession_color": "var(--cc-chalk-mute)" if carrier is None
            else ("var(--cc-home)" if carrier.has(Home) else css(crew(ctx).color)),
            "stamina": round(level * 100),
            "stamina_width": f"{level * 100:.0f}%",
            "stamina_low": level < 0.2,
            "no_shoot": carrier != me,
            "no_pass": not mate_open,
            "no_steal": not self.steal_in_reach(ctx, me, ball, court),
        })
        return state

    def steal_in_reach(self, ctx, me, ball, court) -> bool:
        """A rival carries the ball within your reach: the Steal button is live."""
        carrier = ball.holder
        if carrier is None or team_of(carrier) is team_of(me) or ctx.world.query(Ball, Flight).count():
            return False
        reach = court.steal_range + me.get(Edge).steal_range
        return me.transform.position.distance_to(carrier.transform.position) <= reach


def tip_off_view(ctx) -> None:
    """Play: the title closes and the camera leaves the title's level wide shot (14 m up,
    22 m back) for the template's courtside framing: 7 m up and 10 m back, pitched 28.8°
    down (camera_courtside looks 5.5 m below itself, 10 m ahead). The prefab's min_visible
    keeps 18 m across in view at the 12.14 m focus distance on narrow screens."""
    ctx.ui.close(TitleScreen)
    camera = ctx.camera.main
    camera.offset = vec3(0, 7, 10)
    camera.pitch = -28.8


@ui("title_screen", html="ui/title.html", modal=True, layer="menu")
class TitleScreen(Panel):
    """A modal over the frozen court: closing it is the tip-off."""

    actions = {"play": tip_off_view}

    def state(self, ctx):
        career = ctx.get(Career)
        return {
            "has_career": career.games_played > 0,
            "titles": career.titles,
            "wins": career.games_won,
            "points": career.points,
            "greens": career.greens,
            "best_run": f"{career.best_stage} / {len(ctx.config(CourtRules).ladder)}",
        }


@ui("locker_room", html="ui/locker_room.html", modal=True, layer="menu",
    when=lambda ctx: bool(ctx.get(Run).offers))
class LockerRoom(Panel):
    """Between games: take one perk card into the next one."""

    actions = {"pick": pick}

    def state(self, ctx):
        run = ctx.get(Run)
        ladder = ctx.config(CourtRules).ladder
        upcoming = ladder[run.stage + 1].data
        bag = {}
        for card in run.perks:
            bag[card] = bag.get(card, 0) + 1
        cards = []
        for card in run.offers:
            owned = bag.get(card, 0)
            stacks = max(owned + 1, card.data.max_stacks)
            name = ctx.text(card.data.name)
            cards.append({
                "card": card.id,
                "name": name,
                "long": len(name) > 12,
                "category": ctx.text(CATEGORY_LABELS[card.data.category]),
                "description": ctx.text(card.data.description),
                "owned": owned > 0,
                "owned_label": f"Owned ×{owned}",
                "pips": [{"state": "on" if k < owned else ("add" if k == owned else "")} for k in range(stacks)],
                "stack": f"×{owned} → ×{owned + 1}",
            })
        return {
            "eyebrow": ctx.text(Text.game_of, number=run.stage + 1, total=len(ladder)).title() + " won",
            "beat": ctx.text(upcoming.taunt),
            "next_crew": ctx.text(upcoming.name),
            "next_color": css(upcoming.color),
            "ladder": ladder_rows(ctx),
            "cards": cards,
            "bag": ", ".join(f"{ctx.text(card.data.name)} ×{count}" if count > 1 else ctx.text(card.data.name)
                             for card, count in bag.items()) or "Empty",
        }


@ui("game_over", html="ui/game_over.html", modal=True, layer="menu",
    when=lambda ctx: ctx.get(Run).result is not Result.RUNNING)
class GameOver(Panel):
    """The end of the run, with your line for the whole run."""

    actions = {"play_again": reload_scene(new_run=True), "quit": reload_scene(new_run=True)}

    def state(self, ctx):
        run, match = ctx.get(Run), ctx.get(Match)
        box = you(ctx).get(BoxScore)
        champions = run.result is Result.CHAMPIONS
        stat = lambda label, value: {"label": ctx.text(label), "value": str(value)}
        return {
            "won": champions,
            "kicker": "Run complete" if champions else "Run over",
            "title": ctx.text(Text.champions if champions else Text.run_over).title(),
            "final": ctx.text(Text.final_score, home=match.home_score, away=match.away_score),
            "points": box.points,
            "ladder": ladder_rows(ctx, finished=True),
            "stats": [
                stat(Text.games_won, run.stage + (1 if champions else 0)),
                stat(Text.shooting, ctx.text(Text.shooting_line, made=box.made, attempts=box.attempts)),
                stat(Text.greens, box.greens),
                stat(Text.assists, box.assists),
                stat(Text.rebounds, box.rebounds),
                stat(Text.steals, box.steals),
            ],
        }
