"""Recognising crimes, the wanted meter, dispatching units, and arrests."""

import math

from parallax import Context, Entity, PrefabRef, System, Tag, Vec3, on, system
from parallax.combat import Damaged
from parallax.vehicles import VehicleEntered
from project import Content, Prefabs, Text

from features.city_life.feature import Pedestrian, RunOver
from features.driving.feature import Lent, VehicleWrecked, player_car
from features.on_foot.feature import Player, PlayerRecovered, Setback, Wallet, WeaponFired, begin_recovery
from features.police.components import Spotter
from features.police.config import Pursuit
from features.police.content import PoliceTierDef
from features.police.events import CrimeCommitted, PlayerBusted
from features.police.resources import Phase, Wanted, pursuing, wanted_level
from features.police.tags import Chopper, Cruiser, Dispatched, Officer, Roadblock
from game.audio import Sounds, play


@system("crimes")
class Crimes(System):
    """Turns what the player does into crimes: shooting, hurting people, taking cars that are not
    lent to them, and wrecking cars. Jobs report their own crimes directly."""

    @on(WeaponFired, where=lambda event: event.by.has(Player))
    def gunfire(self, ctx, event: WeaponFired):
        ctx.emit(CrimeCommitted(crime=Content.crime.gunfire, at=event.at))

    @on(Damaged, where=lambda event: by_player(event.source) and not event.entity.has(Player))
    def violence(self, ctx, event: Damaged):
        crime = Content.crime.hit_and_run if event.kind == RunOver else Content.crime.assault
        ctx.emit(CrimeCommitted(crime=crime, at=event.entity.transform.position))

    @on(VehicleEntered, where=lambda event: event.source.has(Player) and not event.entity.has(Lent))
    def car_theft(self, ctx, event: VehicleEntered):
        ctx.emit(CrimeCommitted(crime=Content.crime.car_theft, at=event.entity.transform.position))

    @on(VehicleWrecked, where=lambda event: by_player(event.driver))
    def wreck(self, ctx, event: VehicleWrecked):
        ctx.emit(CrimeCommitted(crime=Content.crime.wrecked_car, at=event.vehicle.transform.position))


@system("wanted_level", when=pursuing)
class WantedLevel(System):
    """Adds witnessed crimes to the meter (at any time) and, while a pursuit is on, runs its phases: chase
    while any unit sees the player, search once they have been out of sight a while, calm once the police
    give up."""

    @on(CrimeCommitted, always=True)
    def report(self, ctx, event: CrimeCommitted):
        crime = event.crime.data
        player = ctx.world.query(tagged=Player).single()
        if crime.witnessed and not self.witnessed(ctx, player, crime.witness_radius):
            return
        wanted = ctx.get(Wanted)
        before = wanted_level(wanted)
        wanted.heat = min(ctx.config(Pursuit).max_heat, wanted.heat + crime.heat)
        wanted.phase = Phase.CHASE
        wanted.unseen_for = 0.0
        wanted.last_seen = player.transform.position
        if wanted_level(wanted) > before:
            tier = tier_for(ctx, wanted_level(wanted))
            ctx.ui.toast(ctx.text(Text.wanted_up, crime=ctx.text(crime.name), tier=ctx.text(tier.label)))
            play(ctx, ctx.config(Sounds).wanted)

    @on(PlayerRecovered)
    def wiped(self, ctx, event):
        ctx.reset(Wanted)

    def update(self, ctx, dt):
        wanted = ctx.get(Wanted)
        player = ctx.world.query(tagged=Player).single()
        if self.spotted(ctx, player):
            wanted.phase = Phase.CHASE
            wanted.unseen_for = 0.0
            wanted.last_seen = player.transform.position
            return
        wanted.unseen_for += dt
        rules = ctx.config(Pursuit)
        if wanted.unseen_for >= rules.lose_after:
            ctx.reset(Wanted)
            ctx.ui.toast(Text.wanted_lost)
        elif wanted.unseen_for >= rules.search_after:
            wanted.phase = Phase.SEARCH

    def witnessed(self, ctx, player: Entity, radius: float) -> bool:
        here = player.transform.position
        onlookers = (
            ctx.world.query(tagged=Pedestrian).near(here, radius).entities()
            + ctx.world.query(Spotter).near(here, radius).entities()
        )
        return any(ctx.nav.can_see(witness, player, distance=radius) for witness in onlookers)

    def spotted(self, ctx, player: Entity) -> bool:
        here = player.transform.position
        for unit, spotter in ctx.world.query(Spotter).near(here, 200):
            if unit.transform.position.distance_to(here) > spotter.range:
                continue
            if not spotter.needs_line_of_sight or ctx.nav.can_see(unit, player, fov=spotter.fov, distance=spotter.range):
                return True
        return False


@system("dispatch", when=lambda ctx: not pursuing(ctx))
class Dispatch(System):
    """Every `dispatch_interval` during a pursuit, sends units toward the last sighting, out of the player's
    view, until the street matches the star level. Once calm, recalls dispatched units as soon as they are
    off screen or far away."""

    def start(self, ctx):
        ctx.time.every(ctx.config(Pursuit).dispatch_interval, lambda: self.reinforce(ctx))

    def update(self, ctx, dt):
        here = ctx.world.query(tagged=Player).single().transform.position
        stand_down = ctx.config(Pursuit).stand_down
        for unit in ctx.world.query(tagged=Dispatched):
            position = unit.transform.position
            if position.distance_to(here) > stand_down or ctx.camera.main.world_to_screen(position) is None:
                unit.destroy()

    def reinforce(self, ctx):
        if not pursuing(ctx):
            return
        wanted = ctx.get(Wanted)
        rules = ctx.config(Pursuit)
        tier = tier_for(ctx, wanted_level(wanted))
        here = ctx.world.query(tagged=Player).single().transform.position
        anchor = wanted.last_seen
        if units(ctx, Officer) < tier.officers:
            self.send(ctx, Prefabs.police_officer, ctx.nav.random_point(anchor, rules.spawn_max), here)
        if units(ctx, Cruiser) < tier.cruisers:
            self.send(ctx, Prefabs.police_cruiser, ctx.nav.random_point(anchor, rules.spawn_max), here)
        if units(ctx, Chopper) < tier.helicopters:
            sky = anchor + Vec3.UP * rules.helicopter_altitude + Vec3.BACK * rules.spawn_min
            self.send(ctx, Prefabs.police_helicopter, sky, here)
        car = player_car(ctx)
        if tier.roadblock and car is not None and units(ctx, Roadblock) == 0:
            ahead = here + car.transform.forward.flat().normalized() * rules.roadblock_ahead
            self.send(ctx, Prefabs.roadblock, ctx.nav.random_point(ahead, 8), here, facing=car)

    def send(self, ctx, prefab: PrefabRef, point: Vec3 | None, here: Vec3, facing: Entity | None = None):
        """Spawn a unit at `point` if it is far enough away and out of sight."""
        if point is None or point.distance_to(here) < ctx.config(Pursuit).spawn_min:
            return
        if ctx.camera.main.world_to_screen(point) is not None:
            return
        rotation = facing.transform.euler.y + 90 if facing is not None else None
        ctx.world.spawn(prefab, at=point, rotation=rotation, tags=[Dispatched])


@system("arrests")
class Arrests(System):
    """BUSTED: a fine, the heat wiped, and a short ride to the station."""

    @on(PlayerBusted)
    def booked(self, ctx, event):
        rules = ctx.config(Pursuit)
        wallet = ctx.get(Wallet)
        fine = math.floor(wallet.cash * rules.arrest_fine)
        wallet.cash -= fine
        ctx.reset(Wanted)
        begin_recovery(ctx, Setback.BUSTED, rules.release, rules.busted_seconds)
        ctx.ui.toast(ctx.text(Text.busted_fine, fine=fine), seconds=4)


def tier_for(ctx: Context, stars: int) -> PoliceTierDef:
    return ctx.content(PoliceTierDef).first(lambda tier: tier.stars == stars).data


def units(ctx: Context, kind: Tag) -> int:
    return ctx.world.query(tagged=[kind, Dispatched]).count()


def by_player(entity: Entity | None) -> bool:
    return entity is not None and entity.has(Player)
