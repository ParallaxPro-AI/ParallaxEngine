"""Panels: title, HUD, upgrade draft, pause menu and run debrief, ported from the template's
Dustline screens (ui/*.html share ui/dustline.css), plus the HUD kit's crosshair, minimap
and waypoint panels restyled in the same kit. Each one opens from state or input; no
system opens or closes a panel."""

import math

from parallax import Panel, SettingsPanel, close_panel, load_scene, open_panel, reload_scene, ui
from parallax.combat import Health
from parallax.hud import CrosshairPanel, MarkersPanel, MinimapPanel
from project import Scenes, Text

from game.actions import FpsControls
from game.arena import current_round
from game.components import Arsenal, Bot, Plating, Player
from game.config import MatchRules
from game.content import RoundDef, WeaponKind
from game.resources import Career, FeedKind, Match, Mods, Phase
from game.run import take_upgrade


def grouped(n: int) -> str:
    return f"{round(n):,}"


def clock(seconds: float) -> str:
    whole = int(seconds)
    return f"{whole // 60}:{whole % 60:02d}"


def percent(fraction: float) -> str:
    return f"{max(0.0, min(1.0, fraction)) * 100:.1f}%"


def short_name(ctx, fight: RoundDef) -> str:
    """The round name without its "Round n — " prefix (the HUD prints the number itself)."""
    return ctx.text(fight.name).split(" — ", 1)[-1]


def run_clock(match: Match, now: float) -> str:
    return clock((match.ended_at if match.ended_at >= 0 else now) - match.started_at)


def accuracy(shots: int, hits: int) -> int:
    return round(100 * hits / shots) if shots else 0


def chips(ctx, match: Match) -> list[dict]:
    return [{"icon": card.data.icon, "name": ctx.text(card.data.name)} for card in match.taken]


def sector(ctx, z: float) -> str:
    for area in ctx.config(MatchRules).sectors:
        if z < area.below_z:
            return ctx.text(area.name)
    return ""


@ui("title_screen", html="ui/title.html", layer="menu")
class TitleScreen(Panel):
    actions = {"start": load_scene(Scenes.arena, new_run=True)}

    def state(self, ctx):
        career = ctx.get(Career)
        rounds = len(ctx.content(RoundDef))
        played = career.runs > 0
        possible = rounds * career.runs
        return {
            "rounds": rounds,
            "lives": ctx.config(MatchRules).lives,
            "runs": grouped(career.runs) if played else "—",
            "wins": grouped(career.wins) if played else "—",
            "frags": grouped(career.frags) if played else "—",
            "best": grouped(career.best.score) if played else "—",
            "cleared": f"{career.rounds}/{possible}" if played else "—",
            "cleared_fill": percent(career.rounds / possible if possible else 0),
        }


@ui("pause_menu", html="ui/pause.html", modal=True, layer="menu",
    scenes=[Scenes.arena], toggle_with=FpsControls.pause)
class PauseMenu(Panel):
    actions = {
        "resume": close_panel(),
        "settings": open_panel(SettingsPanel),
        "quit": load_scene(Scenes.title, new_run=True),
    }

    def state(self, ctx):
        match = ctx.get(Match)
        return {
            "round": match.round + 1,
            "rounds": len(ctx.content(RoundDef)),
            "round_name": short_name(ctx, current_round(ctx)),
            "score": grouped(match.score),
            "lives": match.lives,
            "clock": run_clock(match, ctx.time.now),
            "has_accuracy": match.shots > 0,
            "accuracy": f"{accuracy(match.shots, match.hits)}%",
        }


@ui("hud", html="ui/hud.html")
class Hud(Panel):
    actions = {"pause": open_panel(PauseMenu)}

    def state(self, ctx):
        you, health, plating, arsenal = ctx.world.query(Health, Plating, Arsenal, tagged=Player).single()
        match, rules, now = ctx.get(Match), ctx.config(MatchRules), ctx.time.now
        weapon = arsenal.weapons[arsenal.current]
        fight = current_round(ctx)
        rounds = len(ctx.content(RoundDef))
        step = rules.streak_step + ctx.get(Mods).streak_step_add
        multiplier = min(rules.streak_max, 1 + step * max(0, match.streak - 1))
        lives_shown = max(match.lives_max, match.lives)
        respawn_left = match.player_respawn_at - now if match.player_respawn_at >= 0 else 0
        return {
            "score": grouped(match.score),
            "streak_text": ctx.text(Text.streak_multiplier, mul=f"{multiplier:.1f}") if match.streak > 1 and multiplier > 1 else "",
            "round": match.round + 1,
            "rounds": rounds,
            "round_name": short_name(ctx, fight),
            "tagline": ctx.text(fight.tagline),
            "segs": [{"on": i < match.frags} for i in range(fight.frag_target)],
            "frags": match.frags,
            "frag_target": fight.frag_target,
            "roster": sum(entry.count for entry in fight.roster),
            "alive": ctx.world.query(Bot).count(),
            "lives": match.lives,
            "pips": [{"on": i < match.lives} for i in range(lives_shown)],
            "sector": sector(ctx, you.transform.position.z),
            "perks": chips(ctx, match),
            "clock": run_clock(match, now),
            "health": math.ceil(health.current),
            "health_max": round(health.max),
            "health_fill": percent(health.current / health.max),
            "low": 0 < health.current < health.max * 0.3,
            "armor": math.ceil(plating.points),
            "armor_max": round(rules.armor_max),
            "armor_fill": percent(plating.points / rules.armor_max),
            "weapon": ctx.text(weapon.data.name),
            "loaded": arsenal.loaded[weapon],
            "reserve": arsenal.reserve[weapon],
            "mag_low": arsenal.loaded[weapon] <= 5,
            "reloading": arsenal.reload_done_at >= 0,
            "scoped": arsenal.zoomed and weapon.data.scoped,
            "slots": [
                {"key": str(i + 1), "label": ctx.text(gun.data.short), "on": i == arsenal.current,
                 "count": f"×{arsenal.loaded[gun]}" if gun.data.kind is WeaponKind.THROWN else ""}
                for i, gun in enumerate(arsenal.weapons)
            ],
            "banner_on": now - match.banner_at < rules.banner_seconds,
            "banner_seconds": f"{rules.banner_seconds}s",
            "feed": [
                {"id": line.id, "text": line.text, "death": line.kind is FeedKind.DEATH,
                 "buff": line.kind is FeedKind.BUFF, "elite": line.kind is FeedKind.ELITE,
                 "streak": line.kind is FeedKind.STREAK,
                 "points": f"+{grouped(line.points)}" if line.points else "",
                 "multiplier": f"x{line.multiplier:.1f}" if line.multiplier else ""}
                for line in reversed(match.feed) if now - line.at < rules.feed_seconds
            ],
            "feed_seconds": f"{rules.feed_seconds}s",
            "eliminated": match.player_respawn_at >= 0,
            "respawn_in": max(0, math.ceil(respawn_left)),
            "respawn_fill": percent(1 - respawn_left / rules.respawn_delay),
        }


@ui("upgrade_choice", html="ui/upgrade_choice.html", modal=True, layer="menu",
    when=lambda ctx: ctx.get(Match).phase is Phase.INTERMISSION)
class UpgradeChoice(Panel):
    actions = {"pick": take_upgrade}

    def state(self, ctx):
        match = ctx.get(Match)
        upcoming = ctx.content(RoundDef)[match.round + 1].data
        return {
            "sub": ctx.text(Text.draft_sub, round=match.round + 1),
            "cards": [
                {"upgrade": card.id, "icon": card.data.icon, "name": ctx.text(card.data.name),
                 "description": ctx.text(card.data.description)}
                for card in match.offer
            ],
            "banked": chips(ctx, match),
            "next": f"{ctx.text(Text.round_word)} {match.round + 2} — {short_name(ctx, upcoming)}",
        }


@ui("run_over", html="ui/run_over.html", modal=True, layer="menu",
    when=lambda ctx: ctx.get(Match).phase in (Phase.WON, Phase.LOST))
class RunOver(Panel):
    actions = {"again": reload_scene(new_run=True), "quit": load_scene(Scenes.title, new_run=True)}

    def state(self, ctx):
        match, career = ctx.get(Match), ctx.get(Career)
        won = match.phase is Phase.WON
        total = len(ctx.content(RoundDef))
        cleared = total if won else match.round
        before = match.best_before

        def result(label, run, best, of=0):
            shown = (lambda n: f"{n}/{of}") if of else grouped
            return {"label": ctx.text(label), "run": shown(run), "best": shown(best) if best > 0 else "—",
                    "up": run > best and run > 0}

        return {
            "defeat": not won,
            "headline": ctx.text(Text.victory if won else Text.defeat),
            "eyebrow": ctx.text(Text.run_complete, clock=run_clock(match, ctx.time.now)) if won
            else ctx.text(Text.fell_in_round, round=match.round + 1, name=short_name(ctx, current_round(ctx))),
            "score": grouped(match.score),
            "new_best": match.score > before.score and match.score > 0,
            "previous": ctx.text(Text.previous_best, score=grouped(before.score)) if before.score > 0 else ctx.text(Text.first_record),
            "rounds": f"{cleared}/{total}",
            "frags": match.run_frags,
            "deaths": match.deaths,
            "best_streak": match.best_streak,
            "loadout": chips(ctx, match),
            "results": [
                result(Text.score_label, match.score, before.score),
                result(Text.frags_label, match.run_frags, before.frags),
                result(Text.best_streak_label, match.best_streak, before.streak),
                result(Text.rounds_label, cleared, before.rounds, of=total),
            ],
            "record": [
                {"label": ctx.text(Text.frags_label), "run": grouped(match.run_frags), "life": grouped(career.frags)},
                {"label": ctx.text(Text.deaths_label), "run": grouped(match.deaths), "life": grouped(career.deaths)},
                {"label": ctx.text(Text.shots_fired_label), "run": grouped(match.shots), "life": grouped(career.shots)},
                {"label": ctx.text(Text.accuracy_label), "run": f"{accuracy(match.shots, match.hits)}%",
                 "life": f"{accuracy(career.shots, career.hits)}%"},
                {"label": ctx.text(Text.best_streak_label), "run": grouped(match.best_streak), "life": grouped(career.best.streak)},
            ],
        }


@ui("dustline_crosshair", html="ui/hud/crosshair.html", layer="hud", scenes=[Scenes.arena])
class DustlineCrosshair(CrosshairPanel):
    """The engine crosshair with the template's Dustline sniper optic."""


@ui("dustline_minimap", html="ui/hud/minimap.html", layer="hud", scenes=[Scenes.arena])
class DustlineMinimap(MinimapPanel):
    """The minimap in the Dustline kit's square frame."""


@ui("dustline_markers", html="ui/hud/markers.html", layer="hud", scenes=[Scenes.arena])
class DustlineMarkers(MarkersPanel):
    """Pickup waypoints as Dustline chips."""

