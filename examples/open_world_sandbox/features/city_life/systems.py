"""Panic at gunfire, cars hitting people, and street cash. The city plugin keeps the street populated."""

import random

from parallax import Collided, Color, System, Vec3, on, system
from parallax.combat import Died, Health
from parallax.vehicles import Vehicle
from project import Text

from features.city_life.config import Street
from features.city_life.tags import Pedestrian, RunOver
from features.on_foot.feature import Player, Wallet, WeaponFired

CASH = Color.hex("#22c55e")


@system("panic")
class Panic(System):
    """Gunfire sends the city's pedestrians running (the template's crowd fled from every shot)."""

    @on(WeaponFired)
    def shots(self, ctx, event: WeaponFired):
        street = ctx.config(Street)
        ctx.city.alarm(event.at, radius=street.panic_radius, seconds=street.panic_seconds)


@system("roadkill")
class Roadkill(System):
    """A car hitting a pedestrian hurts them in proportion to the impact, credited to its driver."""

    @on(Collided, where=lambda event: event.entity.has(Pedestrian) and event.target.has(Vehicle))
    def struck(self, ctx, event: Collided):
        damage = event.impulse * ctx.config(Street).run_over_damage
        event.entity.get(Health).damage(damage, source=event.target.get(Vehicle).driver, kind=RunOver)


@system("street_cash")
class StreetCash(System):
    """A pedestrian the player takes down drops a little cash."""

    @on(Died, where=lambda event: event.entity.has(Pedestrian) and event.source is not None and event.source.has(Player))
    def rob(self, ctx, event: Died):
        street = ctx.config(Street)
        amount = random.randint(street.cash_per_kill_min, street.cash_per_kill_max)
        ctx.get(Wallet).cash += amount
        ctx.ui.float_text(ctx.text(Text.cash_gain, amount=amount), event.entity.transform.position + Vec3.UP * 1.8, color=CASH)
