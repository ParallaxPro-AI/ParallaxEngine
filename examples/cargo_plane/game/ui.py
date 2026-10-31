"""Panels, in the template's flight-manifest look (ui/sky_freight.css). The title and HUD
are listed by their scenes; pause exists out in the archipelago and follows its key, the
game-over screen follows the career, and the office is opened at a depot. Buttons that
do more than open or close something are plain functions."""

from parallax import Panel, Settings, close_panel, load_scene, open_panel, ui
from parallax.hud import MarkersPanel
from project import Scenes, Text

from game.actions import Controls
from game.career_slot import new_career, start_engine
from game.config import FreightRules
from game.content import UpgradeDef, UpgradeStat
from game.office import buy_upgrade, take_contract
from game.readout import career_strip, flight_hud
from game.resources import Board, Career, Outcome
from game.rules import airframes_left, money, rank, upgrade_price

to_title = load_scene(Scenes.title, new_run=True)


@ui("title_screen", html="ui/title.html", modal=True, layer="menu")
class TitleScreen(Panel):
    """Form SF-1: the altimeter dials, the title and Start Engine, which picks the saved
    career up or starts one."""
    actions = {"start": start_engine}


def set_quality(ctx, value: str):
    """The pause settings' Low / Medium / High switch."""
    ctx.get(Settings).quality = value


@ui("pause_settings", html="ui/pause_settings.html", modal=True, layer="menu")
class PauseSettings(Panel):
    """The pause sheet's Settings view: graphics quality with a note per level."""
    actions = {"quality": set_quality, "back": close_panel()}

    def state(self, ctx):
        current = ctx.get(Settings).quality
        levels = (("low", Text.quality_low, Text.quality_low_note), ("medium", Text.quality_medium, Text.quality_medium_note),
                  ("high", Text.quality_high, Text.quality_high_note))
        return {
            "qualities": [{"value": q, "label": ctx.text(label), "pressed": "true" if q == current else "false"}
                          for q, label, _ in levels],
            "note": next((ctx.text(note) for q, _, note in levels if q == current), ""),
        }


@ui("pause_menu", html="ui/pause.html", modal=True, layer="menu",
    scenes=[Scenes.archipelago], toggle_with=Controls.pause)
class PauseMenu(Panel):
    actions = {"resume": close_panel(), "main_menu": to_title, "settings": open_panel(PauseSettings)}


@ui("flight_hud", html="ui/hud.html")
class FlightHud(Panel):
    """The career strip, the job line and deadline, the toast feed, the stall badge, the
    prompts and, in the plane, the instrument strip (game/readout.py)."""
    actions = {"pause": open_panel(PauseMenu)}

    def state(self, ctx):
        return flight_hud(ctx)


@ui("waypoints", html="ui/waypoints.html")
class Waypoints(MarkersPanel):
    """The pickup / drop-off beacons' markers in the template's look: a bobbing diamond
    with its label on screen, an edge arrow off it."""


@ui("depot_office", html="ui/office.html", modal=True, layer="menu")
class OfficePanel(Panel):
    """Form DO-7, opened by the DepotOffice system when the pilot asks at a pad."""
    actions = {"take": take_contract, "buy": buy_upgrade, "close": close_panel()}

    def state(self, ctx):
        board = ctx.get(Board)
        career = ctx.get(Career)
        rung = ctx.text(rank(ctx).data.name)
        strip = career_strip(ctx)
        return {
            "kicker": ctx.text(Text.office_kicker, island=ctx.text(board.island.data.name)),
            "standing": ctx.text(Text.office_standing, rank=rung, deliveries=career.deliveries),
            "gate": ctx.text(Text.office_gate, rank=rung),
            "bank": strip["bank"],
            "rank": rung,
            "frames": strip["fleet"],
            "loan_bank": strip["bank"],
            "loan_of": f"/ {money(ctx.config(FreightRules).payoff_target)}",
            "loan_pct": strip["loan_pct"],
            "loaded": board.loaded,
            **self.hold(ctx),
            "empty": not board.loaded and not board.offers,
            "offers": [] if board.loaded else [
                {
                    "offer": index,
                    "cargo": ctx.text(offer.cargo.data.name),
                    "blurb": ctx.text(offer.cargo.data.blurb),
                    "route": f"{ctx.text(offer.destination.data.name)} · {offer.leg / 1000:.1f} km",
                    "pay": money(offer.pay),
                    "deadline": f"{int(offer.deadline)}s",
                    "fragile": offer.cargo.data.fragile,
                    "urgent": offer.cargo.data.urgent,
                    "signed": offer == board.contract,
                }
                for index, offer in enumerate(board.offers)
            ],
            "upgrades": [self.upgrade_card(ctx, upgrade) for upgrade in ctx.content(UpgradeDef)],
        }

    def hold(self, ctx):
        """The IN THE HOLD note that replaces the board while a load is aboard."""
        board = ctx.get(Board)
        if not board.loaded:
            return {"hold_cargo": "", "hold_to": "", "hold_meta": ""}
        cargo = board.contract.cargo.data
        seconds = max(0, round(board.time_left))
        clock = ctx.text(Text.hold_late) if board.late else ctx.text(
            Text.hold_deadline, clock=f"{seconds // 60}:{seconds % 60:02d}")
        flags = [clock] + [ctx.text(t) for t, on in ((Text.urgent, cargo.urgent), (Text.fragile, cargo.fragile)) if on]
        return {"hold_cargo": ctx.text(cargo.name), "hold_to": ctx.text(board.contract.destination.data.name),
                "hold_meta": " · ".join(flags)}

    def upgrade_card(self, ctx, upgrade):
        career = ctx.get(Career)
        price = upgrade_price(ctx, upgrade)
        capped = price is None
        afford = not capped and career.money >= price
        airframe = upgrade.data.stat is UpgradeStat.AIRFRAME
        rules = ctx.config(FreightRules)
        return {
            "upgrade": upgrade.id,
            "name": ctx.text(upgrade.data.name),
            "blurb": ctx.text(upgrade.data.blurb),
            "effect": ctx.text(upgrade.data.effect),
            "tier": (f"{airframes_left(ctx)} / {rules.max_airframes}" if airframe else
                     ctx.text(Text.tier, tier=career.upgrades.get(upgrade.id, 0), tiers=len(upgrade.data.costs))),
            "price": "" if capped else money(price),
            "buy_label": "" if capped else ctx.text(Text.buy, price=money(price)),
            "short": "" if capped or afford else ctx.text(Text.short, amount=money(price - career.money)),
            "capped": ctx.text(Text.full if airframe else Text.maxed) if capped else "",
            "afford": afford,
            "dim": not capped and not afford,
        }


@ui("game_over", html="ui/game_over.html", modal=True, layer="menu",
    when=lambda ctx: ctx.get(Career).outcome is not None)
class GameOverPanel(Panel):
    """The career log's final entry: the stamp, the final bank counting up, the stats."""
    actions = {"play_again": new_career, "main_menu": to_title}

    def state(self, ctx):
        career = ctx.get(Career)
        won = career.outcome is Outcome.AIRFIELD_BOUGHT
        home = ctx.text(ctx.config(FreightRules).home.data.name)
        left = airframes_left(ctx)
        return {
            "won": won,
            "stamp": ctx.text(Text.airfield_bought if won else Text.career_grounded),
            "line": ctx.text(Text.airfield_bought_sub, home=home) if won else ctx.text(Text.career_grounded_sub),
            "home": home,
            "score": round(career.money),
            "deliveries": career.deliveries,
            "distance": f"{career.distance_flown / 1000:.1f} km",
            "rank": ctx.text(rank(ctx).data.name),
            "airframes": left,
            "no_airframes": left <= 0,
        }
