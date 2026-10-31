"""The panels, ported from the template's HTML/CSS (ui/kit.css holds its fonts,
tokens and shared classes). Four buttons run game code directly — starting a match
with this night's air, stepping the Tour tier, starting the next leg, the pause
card's graphics level; the rest are built-in commands, and the leg card and result
card follow `Match.stage` after a beat (both are modal, and a modal freezes time,
which would stop the checkout sparks and the dart sticking halfway)."""

from parallax import Panel, Settings, Vec2, vec3, close_panel, load_scene, open_panel, ui
from project import Content, Placed, Scenes, Text

from game.actions import Controls
from game.components import Phase, Throw
from game.config import Cues, House, Release
from game.content import LegDef, TierDef, par_total
from game.darts import Hit, Ring, on_face, to_par_text
from game.resources import Air, Career, LegResult, Match, Result, Stage
from game.systems.scorekeeper import begin_leg

CUT_WARNING_DARTS = 3
CALLOUT_SECONDS = 1.58
GOLD_CALLOUTS = ("maximum", "treble", "double", "bullseye")
QUALITIES = ("low", "medium", "high")

HIT_TEXT = {
    Ring.MISS: Text.hit_miss,
    Ring.INNER_BULL: Text.hit_bullseye,
    Ring.OUTER_BULL: Text.hit_outer_bull,
    Ring.TREBLE: Text.hit_treble,
    Ring.DOUBLE: Text.hit_double,
    Ring.SINGLE: Text.hit_single,
}


def hit_text(ctx, hit: Hit | None) -> str:
    return ctx.text(HIT_TEXT[hit.ring], number=hit.number) if hit else "—"


def start_match(ctx) -> None:
    """Step to the oche (title) and Play again (result card). The seed is the
    house seed plus matches played: a match replays exactly, the next one gets
    a different night's draught."""
    seed = ctx.config(House).draught_seed + ctx.get(Career).matches
    ctx.scenes.load(Scenes.oche_hall, seed=seed)


def step_tier(ctx, step: int) -> None:
    """The title card's ◀ ▶ (`data-step="-1"` / `"1"`): move along the Tour, no
    further than the highest tier unlocked."""
    career = ctx.get(Career)
    career.tier = min(max(career.tier + step, 0), career.unlocked)
    cue = ctx.config(Cues).ready
    ctx.audio.play(cue.sound, volume=cue.volume * 0.5)


def set_quality(ctx, quality: str) -> None:
    """The pause card's Low / Medium / High (the template's inline graphics selector)."""
    if quality in QUALITIES:
        ctx.get(Settings).quality = quality


def signed(n: int) -> str:
    """To-par and points the way the template prints them: E, +3, −2 (a real minus)."""
    text = to_par_text(n)
    return "\u2212" + text[1:] if text.startswith("-") else text


def next_leg(ctx) -> None:
    """The leg card's button. Leaving `Stage.LEG_WON` closes the card."""
    begin_leg(ctx, ctx.get(Match).leg + 1)


@ui("title", html="ui/title.html", modal=True, layer="menu")
class TitleScreen(Panel):
    actions = {"start": start_match, "tier": step_tier}

    def state(self, ctx):
        career = ctx.get(Career)
        ladder = ctx.content(TierDef)
        tier = ladder[career.tier].data
        opener = ctx.content(LegDef)[0].data
        return {
            "tier_position": ctx.text(Text.tier_position, number=career.tier + 1, count=len(ladder)),
            "tier_name": ctx.text(tier.name),
            "tier_blurb": ctx.text(tier.blurb),
            "tier_terms": ctx.text(Text.tier_terms, slack=tier.budget_over_par, mult=tier.score_mult),
            "can_unlock": career.tier == career.unlocked and career.unlocked + 1 < len(ladder),
            "first_tier": career.tier <= 0,
            "top_tier": career.tier >= career.unlocked,
            "clean_band": ctx.text(Text.clean_band, low=round(ctx.config(Release).clean_from * 100),
                                   high=round(ctx.config(Release).clean_to * 100)),
            "opener": ctx.text(Text.leg_line, number=opener.number, name=ctx.text(opener.name),
                               start=opener.start, par=opener.par),
            "card_par": par_total(ctx),
            "best_match": "—" if career.best_over_par is None else signed(career.best_over_par),
            "best_score": career.best_score,
            "matches": career.matches,
            "bullseyes": career.bullseyes,
        }


@ui("pause", html="ui/pause.html", modal=True, layer="menu", scenes=[Scenes.oche_hall], toggle_with=Controls.pause)
class PauseMenu(Panel):
    actions = {"resume": close_panel(), "quality": set_quality, "quit": load_scene(Scenes.title)}

    def state(self, ctx):
        match = ctx.get(Match)
        card = ctx.content(LegDef)
        words = ctx.text(card[match.leg].data.name).split(" ")
        par_so_far = sum(card[played].data.par for played in range(match.leg + 1))
        quality = ctx.get(Settings).quality
        return {
            "title_head": " ".join(words[:-1]) if len(words) > 1 else words[0],
            "title_tail": words[-1] if len(words) > 1 else "",
            "context": f"Leg {match.leg + 1}/{len(card)} · {match.remaining} remaining · To par "
                       + signed(match.total_darts - par_so_far),
            "quality_low": "true" if quality == "low" else "false",
            "quality_medium": "true" if quality == "medium" else "false",
            "quality_high": "true" if quality == "high" else "false",
        }


@ui("hud", html="ui/hud.html")
class Hud(Panel):
    actions = {"pause": open_panel(PauseMenu)}

    def state(self, ctx):
        match = ctx.get(Match)
        air = ctx.get(Air)
        throw = ctx.world.placed(Placed.dart).get(Throw)
        release = ctx.config(Release)
        card = ctx.content(LegDef)
        leg = card[match.leg].data
        par_so_far = sum(card[played].data.par for played in range(match.leg + 1))
        budget_left = par_total(ctx) + match.tier.data.budget_over_par - match.total_darts
        blows_right = Vec2.from_angle(air.bearing).x > 0
        still = air.speed < 0.05 or air.condition == Content.condition.still
        hit = match.last_hit
        to_par = match.total_darts - par_so_far
        power = min(max(throw.power, 0.0), 1.0)
        in_band = release.clean_from <= power <= release.clean_to
        pct = round(power * 100)
        callout_on = ctx.time.now - match.callout_at < CALLOUT_SECONDS and match.callout != ""
        gold = any(word in match.callout.lower() for word in GOLD_CALLOUTS)
        return {
            "tier": ctx.text(match.tier.data.name),
            "leg_name": ctx.text(leg.name),
            "leg_number": leg.number,
            "leg_count": len(card),
            "leg_par": leg.par,
            "leg_start": leg.start,
            "remaining": match.remaining,
            "darts": match.darts,
            "total_darts": match.total_darts,
            "to_par": signed(to_par),
            "under_par": to_par < 0,
            "over_par": to_par > 0,
            "score": f"{match.score:,}",
            "budget_left": budget_left,
            "cut_close": budget_left <= CUT_WARNING_DARTS,
            "last_dart": hit_text(ctx, hit).upper(),
            "last_miss": hit is not None and hit.ring is Ring.MISS,
            "last_value": hit.value if hit else 0,
            "needle": f"rotate({0 if still else 90 - air.bearing:.1f}deg)",
            "still_air": still,
            "draught_speed": f"{air.speed:.1f}",
            "draught_name": ctx.text(air.condition.data.name),
            "draught_from": "no wind" if still else ctx.text(Text.from_left if blows_right else Text.from_right),
            "callout_on": callout_on,
            "callout": match.callout.upper(),
            "callout_points": ("+" if match.callout_points >= 0 else "\u2212") + str(abs(match.callout_points)),
            "callout_green": match.callout_points >= 0 and not gold,
            "callout_red": match.callout_points < 0,
            "aiming": throw.phase in (Phase.AIMING, Phase.CHARGING),
            "charging": throw.phase is Phase.CHARGING and power > 0,
            "power_pct": f"{pct}%",
            "in_band": in_band,
            "band_left": f"{release.clean_from * 100:.1f}%",
            "band_width": f"{(release.clean_to - release.clean_from) * 100:.1f}%",
            "band_mid": f"{(release.clean_from + release.clean_to) * 50:.1f}%",
            "fill_width": f"calc({pct}% - 6px)",
            "mark_left": f"{pct}%",
            "ring_dash": f"{pct} 100",
            "ring_color": "#7ee08a" if in_band else "#ffd98a",
        }


@ui("aim_line", html="ui/aim_line.html")
class AimLine(Panel):
    """The template's in-game aim overlay: the predicted flight as a bead trail, its
    landing ring and the reticle, projected from the world onto the screen."""

    def state(self, ctx):
        throw = ctx.world.placed(Placed.dart).get(Throw)
        camera = ctx.camera.main
        aiming = throw.phase in (Phase.AIMING, Phase.CHARGING)
        points = [camera.world_to_screen(p) for p in throw.path] if aiming else []
        points = [p for p in points if p is not None]
        board = ctx.world.placed(Placed.board).transform.position
        aim = camera.world_to_screen(board + on_face(throw.aim) + vec3(0, 0, 0.125)) if aiming else None
        end = points[-1] if len(points) >= 2 else None
        return {
            "trail": " ".join(f"{p.x:.1f},{p.y:.1f}" for p in points) if end else "",
            "land_x": f"{end.x:.1f}" if end else "-99",
            "land_y": f"{end.y:.1f}" if end else "-99",
            "land_r": "3" if end else "0",
            "ring_r": "18" if end else "0",
            "reticle_on": aim is not None and end is not None,
            "reticle": f"translate({aim.x:.1f},{aim.y:.1f})" if aim else "translate(-99,-99)",
        }


@ui("leg_card", html="ui/leg_card.html", modal=True,
    when=lambda ctx: ctx.get(Match).stage is Stage.LEG_WON, delay=0.8)
class LegCard(Panel):
    actions = {"next": next_leg}

    def state(self, ctx):
        match = ctx.get(Match)
        card = ctx.content(LegDef)
        finished = match.card[-1]
        upcoming = card[match.leg + 1].data
        return {
            "heading": ctx.text(Text.leg_heading, number=finished.number, name=ctx.text(card[match.leg].data.name),
                                darts=finished.darts),
            "grade": ctx.text(finished.grade.data.name),
            "points": f"+{finished.points:,}",
            "hot": finished.grade.data.max_over_par < 0,
            "has_next": True,
            "next": ctx.text(Text.leg_line, number=upcoming.number, name=ctx.text(upcoming.name),
                             start=upcoming.start, par=upcoming.par),
            "next_blurb": ctx.text(upcoming.blurb),
            "tier": ctx.text(match.tier.data.name),
            "rows": [scorecard_row(ctx, leg.data, match.card, finished.number) for leg in card],
            "total_par": sum(leg.data.par for leg in card if any(r.number == leg.data.number for r in match.card)),
            "total_darts": match.total_darts,
            "total_to_par": signed(sum(result.over_par for result in match.card)),
        }


@ui("game_over", html="ui/game_over.html", modal=True, layer="menu",
    when=lambda ctx: ctx.get(Match).stage is Stage.OVER, delay=0.8)
class GameOver(Panel):
    actions = {"play_again": start_match, "quit": load_scene(Scenes.title)}

    def state(self, ctx):
        match = ctx.get(Match)
        if match.unlocked:
            title = ctx.text(Text.result_unlocked, tier=ctx.text(match.unlocked.data.name))
            subtitle = ctx.text(Text.result_unlocked_line)
        elif match.result is Result.WON:
            title, subtitle = ctx.text(Text.result_won), ctx.text(Text.result_won_line)
        else:
            leg = ctx.content(LegDef)[match.leg].data
            title = ctx.text(Text.result_lost)
            subtitle = ctx.text(Text.result_lost_line, number=leg.number, name=ctx.text(leg.name))
        return {
            "title": title.upper(),
            "won": match.result is Result.WON,
            "subtitle": subtitle,
            "tier": ctx.text(match.tier.data.name),
            "score": f"{match.score:,}",
            "darts": match.total_darts,
            "to_par": signed(match.total_darts - par_total(ctx)),
            "legs": len(match.card),
            "busts": match.busts,
            "maximums": match.maximums,
            "bullseyes": match.bullseyes,
        }


def scorecard_row(ctx, leg: LegDef, results: list[LegResult], fresh: int) -> dict:
    played = next((result for result in results if result.number == leg.number), None)
    return {
        "number": leg.number,
        "name": ctx.text(leg.name),
        "start": leg.start,
        "par": leg.par,
        "darts": played.darts if played else "—",
        "result": ctx.text(played.grade.data.name) if played else "—",
        "hot": played is not None and played.grade.data.max_over_par < 0,
        "todo": played is None,
        "fresh": played is not None and played.number == fresh,
    }
