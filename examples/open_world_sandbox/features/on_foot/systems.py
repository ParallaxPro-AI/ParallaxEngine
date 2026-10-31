"""Where the player is, picking things up, and getting back up."""

import math

from parallax import Color, System, TriggerEntered, Vec3, on, system
from parallax.characters import Character
from parallax.combat import Damaged, Died, Health
from parallax.vehicles import Vehicle
from project import Text

from features.interiors.feature import InteriorZone, interior_at
from features.on_foot.components import Armour, Arsenal, WeaponPickup
from features.on_foot.config import StreetRules
from features.on_foot.events import PlayerRecovered
from features.on_foot.recovery import begin_recovery
from features.on_foot.resources import Location, Recovery, Setback, Wallet
from features.on_foot.tags import Player
from game.audio import Sounds, play
from game.lib.radial_menu import RadialPicked


@system("locator")
class Locator(System):
    """Keeps `Location` pointed at the interior the player stands in, naming it on the way in."""

    def update(self, ctx, dt):
        location = ctx.get(Location)
        inside = interior_at(ctx, ctx.world.query(tagged=Player).single().transform.position)
        if inside is not None and inside != location.interior:
            ctx.ui.toast(inside.get(InteriorZone).name)
        location.interior = inside


@system("pickups")
class Pickups(System):
    """Walking into a weapon, an ammo box or a vest collects it."""

    @on(TriggerEntered, where=lambda event: event.entity.has(WeaponPickup) and event.target.has(Player))
    def collect(self, ctx, event: TriggerEntered):
        pickup = event.entity.get(WeaponPickup)
        arsenal = event.target.get(Arsenal)
        weapon = pickup.weapon or arsenal.current
        if weapon not in arsenal.owned:
            arsenal.owned.append(weapon)
            arsenal.current = weapon
            ctx.ui.toast(ctx.text(Text.weapon_found, weapon=ctx.text(weapon.data.name)))
        arsenal.reserve[weapon] = min(weapon.data.reserve_max, arsenal.reserve.get(weapon, 0) + pickup.ammo)
        if pickup.armour:
            event.target.get(Health).shield = event.target.get(Armour).capacity
        event.entity.destroy()


@system("recovering")
class Recovering(System):
    """WASTED or BUSTED: a short stinger, then the player is back on their feet at the release point."""

    @on(Died, where=lambda event: event.entity.has(Player))
    def wasted(self, ctx, event: Died):
        rules = ctx.config(StreetRules)
        wallet = ctx.get(Wallet)
        wallet.cash -= math.floor(wallet.cash * rules.wasted_fine)
        begin_recovery(ctx, Setback.WASTED, rules.respawn, rules.wasted_seconds)
        play(ctx, ctx.config(Sounds).lights_out)

    def update(self, ctx, dt):
        recovery = ctx.get(Recovery)
        if recovery.countdown.tick(dt):
            self.release(ctx, recovery)

    def release(self, ctx, recovery: Recovery):
        player, health, body = ctx.world.query(Health, Character, tagged=Player).single()
        if body.vehicle is not None:
            body.vehicle.get(Vehicle).exit(player)
        if recovery.release is not None:
            body.teleport(ctx.world.placement(recovery.release).position)
        if health.dead:
            health.revive()
        else:
            health.heal(health.max)
        kind = recovery.kind
        ctx.reset(Recovery)
        ctx.emit(PlayerRecovered(kind=kind))


@system("weapon_wheel")
class WeaponWheel(System):
    """Holding Q opens the radial weapon wheel (library `radial_menu`); a picked wedge draws that
    weapon if Sam owns it. Wedges are named after the weapons (radial_option/<weapon id>)."""

    @on(RadialPicked, where=lambda event: event.group == "weapons")
    def picked(self, ctx, event: RadialPicked):
        arsenal = ctx.world.query(Arsenal, tagged=Player).single()[1]
        weapon = next((owned for owned in arsenal.owned if owned.id == event.option.id), None)
        if weapon is None:
            ctx.ui.toast(ctx.text(Text.weapon_not_owned, weapon=ctx.text(event.option.data.label)))
            return
        if weapon != arsenal.current:
            play(ctx, ctx.config(Sounds).weapon_draw)
        arsenal.current = weapon


@system("damage_numbers")
class DamageNumbers(System):
    """Every hit floats its damage over whoever took it (the template's FloatingText), so a shotgun at
    point blank reads as a bigger number than a stray pellet. Hits on the player are amber."""

    @on(Damaged, where=lambda event: event.amount >= 1)
    def number(self, ctx, event: Damaged):
        at = event.point if event.point is not None else event.entity.transform.position + Vec3.UP * 1.9
        color = Color.hex("#fbbf24") if event.entity.has(Player) else Color.hex("#f4efe6")
        ctx.ui.float_text(str(round(event.amount)), at, color=color)
