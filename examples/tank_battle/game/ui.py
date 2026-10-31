"""Panels: title, HUD, field workshop, pause menu and result screen. Each one opens
from state or input; no system opens or closes a panel.

Every "play again" is `new_campaign`: `new_run=True` clears the loadout too."""

import math

from parallax import Panel, Settings, close_panel, load_scene, open_panel, ui
from parallax.combat import Health
from parallax.vehicles import Vehicle
from project import Scenes, Text

from game.actions import TankControls
from game.campaign import continue_campaign, new_campaign, roll_on
from game.components import BattlefieldScene, EnemyTank, FireControlZone, Gunnery, PlayerTank
from game.config import BattleRules
from game.content import BattlefieldDef
from game.resources import Announcement, BattleState, Campaign, Career, Loadout, Phase

QUIT = load_scene(Scenes.title, new_run=True)


def build(ctx) -> str:
    return " · ".join(ctx.text(card.data.name) for card in ctx.get(Loadout).picks)


QUALITIES = ("low", "medium", "high")


def campaign_order(ctx) -> list:
    """The battlefields in campaign order: from the one no other leads to, along `next`."""
    fields = list(ctx.content(BattlefieldDef))
    targets = {f.data.next for f in fields if f.data.next is not None}
    current = next((f for f in fields if f not in targets), fields[0])
    order = []
    while current is not None and current not in order:
        order.append(current)
        current = current.data.next
    return order + [f for f in fields if f not in order]

# The template's workshop / loadout glyph per upgrade (14 × 14, cyan).
SHAPES = {
    "ap_core": '<polygon points="7,0 14,7 7,14 0,7" fill="#22d3ee"/>',
    "long_rod": '<polygon points="7,1 14,13 0,13" fill="#22d3ee"/>',
    "composite": '<rect x="1" y="1" width="12" height="12" fill="#22d3ee"/>',
    "he_rounds": '<polygon points="7,0 9,5 14,7 9,9 7,14 5,9 0,7 5,5" fill="#22d3ee"/>',
    "spall_liner": '<path d="M5 0h4v5h5v4H9v5H5V9H0V5h5z" fill="#22d3ee"/>',
    "autoloader": '<circle cx="7" cy="7" r="5" fill="none" stroke="#22d3ee" stroke-width="2.5"/><polygon points="9,0 14,3 9,6" fill="#22d3ee"/>',
    "ready_rack": '<rect x="1" y="3" width="3" height="10" fill="#22d3ee"/><rect x="5.5" y="3" width="3" height="10" fill="#22d3ee"/><rect x="10" y="3" width="3" height="10" fill="#22d3ee"/>',
    "torsion_bar": '<polygon points="0,1 6,7 0,13" fill="#22d3ee"/><polygon points="7,1 13,7 7,13" fill="#22d3ee"/>',
    "hydraulics": '<path d="M7 1a6 6 0 1 1-6 6" fill="none" stroke="#22d3ee" stroke-width="2.5"/><polygon points="0,2 5,2 2,7" fill="#22d3ee"/>',
    "field_kit": '<rect x="1" y="3" width="12" height="10" fill="none" stroke="#22d3ee" stroke-width="2"/><path d="M6 5h2v2h2v2H8v2H6V9H4V7h2z" fill="#22d3ee"/>',
}


def icon(upgrade_id: str) -> str:
    """The upgrade's glyph as an inline SVG image."""
    svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 14 14">' + SHAPES.get(upgrade_id, SHAPES["ap_core"]) + "</svg>"
    return "data:image/svg+xml," + svg.replace("#", "%23").replace('"', "'").replace("<", "%3C").replace(">", "%3E")


def set_quality(ctx, quality: str) -> None:
    """The pause card's Graphics Low / Medium / High (the template's own settings view)."""
    if quality in QUALITIES:
        ctx.get(Settings).quality = quality


@ui("title_screen", html="ui/title.html", layer="menu")
class TitleScreen(Panel):
    actions = {"start": new_campaign, "continue": continue_campaign}

    def state(self, ctx):
        career = ctx.get(Career)
        resume = career.furthest is not None
        return {
            "best_score": f"{career.best_score:,}",
            "total_kills": career.total_kills,
            "victories": career.victories,
            "can_continue": resume,
            "status_1": "CAMPAIGN SAVED" if resume else "ENGINE HOT",
            "status_2": ("· " + ctx.text(career.furthest.data.name).upper()) if resume else "",
        }


@ui("pause_menu", html="ui/pause.html", modal=True, layer="menu", scenes=[BattlefieldScene],
    toggle_with=TankControls.pause)
class PauseMenu(Panel):
    actions = {"resume": close_panel(), "quality": set_quality, "quit": QUIT}

    def state(self, ctx):
        quality = ctx.get(Settings).quality
        return {f"quality_{q}": "true" if quality == q else "false" for q in QUALITIES}


ANNOUNCE_COLORS = {"info": "#22d3ee", "warn": "#f59e0b", "success": "#22c55e", "danger": "#ef4444"}
ANNOUNCE_KICKERS = {"info": "INCOMING", "warn": "WEAPONS FREE", "success": "SECTOR HOLDING", "danger": "WARNING"}


@ui("announcer", html="ui/announcer.html")
class Announcer(Panel):
    """The template's announcer band: slides in for `hold` seconds; a WAVE banner counts
    down in its ring, one digit a second."""

    def state(self, ctx):
        banner = ctx.get(Announcement)
        elapsed = ctx.time.now - banner.at
        showing = 0 <= elapsed < banner.hold
        leaving = banner.hold <= elapsed < banner.hold + 0.3
        countdown = showing and banner.style == "info" and banner.text.startswith("WAVE") and banner.hold >= 1
        color = ANNOUNCE_COLORS.get(banner.style, ANNOUNCE_COLORS["info"])
        return {
            "band_class": f"band {banner.style}" + (" in" if showing else (" out" if leaving else "")),
            "band_style": f"--ac: {color}; --hc: {'#e8e8e8' if banner.style == 'info' else color}",
            "kick": ANNOUNCE_KICKERS.get(banner.style, ""),
            "text": banner.text,
            "sub": banner.sub,
            "countdown": countdown,
            "digit": max(1, min(9, round(banner.hold) - int(max(0.0, elapsed)))) if countdown else "",
            "arc_offset": f"{364.4 * (max(0.0, elapsed) % 1):.1f}",
        }


@ui("hud", html="ui/hud.html")
class Hud(Panel):
    actions = {"pause": open_panel(PauseMenu)}

    def state(self, ctx):
        tank, health, gunnery, vehicle = ctx.world.query(Health, Gunnery, Vehicle, tagged=PlayerTank).single()
        battle, campaign, rules = ctx.get(BattleState), ctx.get(Campaign), ctx.config(BattleRules)
        reloading = gunnery.reload_done_at >= 0
        repair_left = max(0.0, gunnery.repair_ready_at - ctx.time.now)
        order = campaign_order(ctx)
        enemies = ctx.world.query(EnemyTank).count()
        reload_left = max(0.0, gunnery.reload_done_at - ctx.time.now) if reloading else 0.0
        picks = ctx.get(Loadout).picks
        return {
            "battlefield": ctx.text(campaign.battlefield.data.name),
            "battlefield_number": order.index(campaign.battlefield) + 1,
            "battlefield_count": len(order),
            "wave": battle.wave,
            "wave_count": len(campaign.battlefield.data.waves),
            "enemies_left": enemies,
            "no_hostiles": enemies == 0,
            "kills": campaign.kills,
            "score": f"{campaign.score:,}",
            "hull": math.ceil(health.current),
            "hull_max": math.ceil(health.max),
            "hull_width": f"{health.fraction * 100:.1f}%",
            "critical": health.fraction <= 0.25,
            "not_critical": health.fraction > 0.25,
            "speed": round(abs(vehicle.speed) * 3.6),
            "ammo": gunnery.ammo,
            "capacity": gunnery.capacity,
            "empty": gunnery.ammo == 0,
            "rounds": [{"spent": i >= gunnery.ammo} for i in range(min(12, gunnery.capacity))],
            "not_reloading": not reloading,
            "reload_text": f"{reload_left:.1f}s",
            "reload_width": f"{(1 - reload_left / max(0.01, gunnery.reload_seconds)) * 100:.1f}%",
            "repair_ready": repair_left <= 0,
            "repair_cooling": repair_left > 0,
            "repair_text": "REPAIR READY" if repair_left <= 0 else "REPAIR · COOLDOWN",
            "repair_cd": "" if repair_left <= 0 else f"{math.ceil(repair_left)}s",
            "repair_width": f"{min(1.0, repair_left / max(0.01, gunnery.repair_seconds)) * 100:.1f}%",
            "off_point": ctx.world.query(tagged=FireControlZone).near(tank.transform.position, rules.fire_point_radius).count() == 0,
            "no_loadout": len(picks) == 0,
            "loadout": [{"name": ctx.text(card.data.name), "icon": icon(card.id)} for card in picks],
        }


@ui("workshop", html="ui/workshop.html", modal=True, layer="menu",
    when=lambda ctx: ctx.get(BattleState).phase is Phase.WORKSHOP)
class Workshop(Panel):
    actions = {"pick": roll_on}

    def state(self, ctx):
        battle = ctx.get(BattleState)
        return {
            "cards": [
                {"upgrade": card.id, "icon": icon(card.id), "name": ctx.text(card.data.name),
                 "description": ctx.text(card.data.description)}
                for card in battle.offer
            ],
            "build": build(ctx),
            "seconds_left": f"{max(0, math.ceil(battle.offer_expires_at - ctx.time.real_now))}s",
            "timer_offset": f"{100.5 * (1 - max(0.0, battle.offer_expires_at - ctx.time.real_now) / ctx.config(BattleRules).upgrade_auto_pick):.1f}",
        }


@ui("result_screen", html="ui/result.html", modal=True, layer="menu",
    when=lambda ctx: ctx.get(BattleState).phase in (Phase.WON, Phase.LOST))
class ResultScreen(Panel):
    actions = {"retry": new_campaign, "quit": QUIT}

    def state(self, ctx):
        battle, campaign = ctx.get(BattleState), ctx.get(Campaign)
        won = battle.phase is Phase.WON
        hull = round(ctx.world.query(Health, tagged=PlayerTank).single()[1].fraction * 100)
        stat = lambda label, value: {"label": label, "value": str(value)}
        return {
            "won": won,
            "lost": not won,
            "kicker": "ALL FRONTS SECURED" if won else "HULL BREACHED",
            "headline": ctx.text(Text.victory if won else Text.defeat).upper(),
            "score": f"{campaign.score:,}",
            "stats": [
                stat("Sector", ctx.text(campaign.battlefield.data.name)),
                stat("Wave", f"{battle.wave}/{len(campaign.battlefield.data.waves)}"),
                stat("Kills", campaign.kills),
                stat("Hull", f"{hull}%"),
                stat("Best", f"{ctx.get(Career).best_score:,}"),
                stat("Loadout", build(ctx) or ctx.text(Text.no_upgrades)),
            ],
        }
