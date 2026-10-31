"""The HUD: one panel bound to state from every feature. It draws what the template split over five
panels (crime_hud, vehicle, episode, lights_out and the BUSTED stinger)."""

import math

from parallax import Context, Entity, Panel, open_panel, ui
from parallax.combat import Health
from parallax.vehicles import Vehicle
from project import Text

from features.driving.feature import CarCondition, Lent, nearest_free_car, player_car
from features.interiors.feature import InteriorZone
from features.missions.feature import ContractsPanel, objective
from features.on_foot.feature import Armour, Arsenal, Location, Player, Recovery, Setback, Wallet
from features.phone.feature import PhotoMode
from features.police.feature import Phase, Wanted, wanted_level
from game.ui import PauseMenu

# The weapons the template's HUD has a silhouette for (code/ui/hud/crime_hud.html ICON); others use the pistol's.
SILHOUETTES = ("pistol", "shotgun")


@ui("hud", html="ui/hud.html")
class Hud(Panel):
    """Wanted stars with the SEARCH flash, health and armour, the weapon in hand, the steal / borrow
    prompt, the driving cluster, cash, the contract ticket and objective banner, the interior name, and
    the LIGHTS OUT / BUSTED stingers. Hidden while taking photos."""

    actions = {"pause": open_panel(PauseMenu), "contracts": open_panel(ContractsPanel)}

    def state(self, ctx):
        player = ctx.world.query(tagged=Player).single()
        wanted = ctx.get(Wanted)
        stars = wanted_level(wanted)
        searching = stars > 0 and wanted.phase is Phase.SEARCH
        recovery = ctx.get(Recovery).kind
        health = player.get(Health)
        job = objective(ctx)
        return {
            "photographing": ctx.get(PhotoMode).active,
            "star_row": [{"on": i < stars} for i in range(5)],
            "searching": searching,
            "heat": stars >= 5 and not searching,
            "eyebrow": banner_eyebrow(ctx, stars, job),
            "health": {"width": percent(health.fraction), "value": round(health.current), "low": health.fraction < 0.35},
            "armour": armour(player),
            "cash": ctx.get(Wallet).cash,
            "weapon": weapon(ctx, player),
            "car": car(ctx),
            "prompt": prompt(ctx, player),
            "interior": interior(ctx),
            "job": job,
            "lights_out": recovery is Setback.WASTED,
            "busted": recovery is Setback.BUSTED,
        }


def percent(fraction: float) -> str:
    return f"{max(0.0, min(1.0, fraction)) * 100:.1f}%"


def armour(player: Entity) -> dict[str, object]:
    """The vest's remaining shield, as the template's 0..100 armour row (hidden at 0)."""
    capacity = player.get(Armour).capacity
    points = player.get(Health).shield / capacity * 100 if capacity else 0.0
    return {"shown": points > 0, "width": percent(points / 100), "value": round(points)}


def weapon(ctx: Context, player: Entity) -> dict[str, object]:
    arsenal = player.get(Arsenal)
    held = arsenal.current
    shape = held.id if held.id in SILHOUETTES else "pistol"
    return {
        "name": ctx.text(held.data.name),
        "armed": not held.data.melee,
        "loaded": arsenal.loaded.get(held, 0),
        "reserve": arsenal.reserve.get(held, 0),
        "shape": {name: name == shape for name in SILHOUETTES},
    }


def car(ctx: Context) -> dict[str, object]:
    """The tachometer: km/h, the needle and arc as a fraction of the car's top speed (the template's
    no-rpm fallback), the redline past 81%, and the body integrity bar."""
    driven = player_car(ctx)
    if driven is None:
        return {"driving": False, "kmh": 0, "arc": "0deg", "needle": "rotate(135deg)", "redline": False,
                "body": "100%", "body_value": 100, "body_low": False}
    vehicle = driven.get(Vehicle)
    speed = abs(vehicle.speed)
    f = max(0.0, min(1.0, speed / vehicle.max_speed)) if vehicle.max_speed > 0 else 0.0
    body = 1 - driven.get(CarCondition).damage
    return {
        "driving": True,
        "kmh": math.floor(speed * 3.6),
        "arc": f"{270 * f:.1f}deg",
        "needle": f"rotate({135 + 270 * f:.1f}deg)",
        "redline": f > 0.8125,
        "body": percent(body),
        "body_value": round(max(0.0, body) * 100),
        "body_low": body < 0.35,
    }


def prompt(ctx: Context, player: Entity) -> dict[str, object]:
    """"Steal car" with its Crime chip, or "Borrow Mara's car", while a free car is in reach on foot."""
    if player_car(ctx) is not None:
        return {"shown": False, "text": "", "crime": False}
    free = nearest_free_car(ctx, player)
    if free is None:
        return {"shown": False, "text": "", "crime": False}
    lent = free.has(Lent)
    return {"shown": True, "text": ctx.text(Text.prompt_borrow if lent else Text.prompt_steal), "crime": not lent}


def banner_eyebrow(ctx: Context, stars: int, job: dict[str, object]) -> str:
    if stars > 0:
        return ctx.text(Text.eyebrow_wanted_one if stars == 1 else Text.eyebrow_wanted, stars=stars)
    if job["active"]:
        return f"{job['title']} · {job['contact']}"
    return ctx.text(Text.eyebrow_free_roam)


def interior(ctx: Context) -> str:
    zone = ctx.get(Location).interior
    return ctx.text(zone.get(InteriorZone).name) if zone is not None else ""
