"""Cars, crimes and the police, played through real inputs."""

from parallax import Animator, heading_to, vec3
from parallax.characters import Character
from parallax.city import CityCar
from parallax.combat import Health
from parallax.hud import Minimap
from parallax.physics import Collider
from parallax.vehicles import Vehicle
from parallax.test import GameHarness, playtest
from project import Content, Placed, Scenes

from features.driving.feature import CarCondition, DrivingControls, player_car
from features.on_foot.feature import Arsenal, OnFootControls, StreetRules, Wallet
from features.police.behaviors import line_of_fire
from features.police.feature import CrimeCommitted, Phase, Pursuit, Wanted, wanted_level
from game.lib.radial_menu import RadialControls, RadialMenu
from game.lib.map_screen import MapControls, MapCorner, MapScreen, MapScreenConfig
from game.hud import Hud
from game.ui import TitleScreen


@playtest("borrowing Mara's car is not a crime; taking the van is")
async def test_borrow_versus_steal(game: GameHarness):
    await game.start(scene=Scenes.sunset_bay, seed=11)
    player = game.world.placed(Placed.player)
    maras_car = game.world.placed(Placed.maras_car)
    player.transform.position = maras_car.transform.position + vec3(2, 0, 0)
    await game.advance(frames=2)
    await game.press(OnFootControls.enter)
    await game.advance(frames=2)
    assert player.get(Character).vehicle == maras_car
    assert game.emitted(CrimeCommitted) == []

    await game.press(DrivingControls.exit)
    player.transform.position = game.world.placed(Placed.harbor_van).transform.position + vec3(2, 0, 0)
    await game.advance(frames=2)
    await game.press(OnFootControls.enter)
    await game.advance(frames=2)
    assert [e.crime for e in game.emitted(CrimeCommitted)] == [Content.crime.car_theft]


@playtest("Sam sits in the driver's seat facing forward and steps out beside the driver's door")
async def test_driver_seat(game: GameHarness):
    await game.start(scene=Scenes.sunset_bay, seed=11)
    player = game.world.placed(Placed.player)
    car = game.world.placed(Placed.maras_car)
    await game.advance(seconds=0.5)
    player.get(Character).teleport(car.transform.position - car.transform.right * 2.2)
    await game.advance(frames=2)
    await game.press(OnFootControls.enter)
    await game.advance(frames=3)
    assert player.get(Character).vehicle == car
    seat = car.transform.to_local(car.get(Vehicle).seats[0].transform.position)
    assert seat.x < 0, "the driver's seat is on the left"
    assert player.transform.position.distance_to(car.transform.to_world(seat)) < 0.05
    assert player.transform.forward.dot(car.transform.forward) > 0.99
    assert player.get(Animator).state == "drive"

    await game.press(DrivingControls.exit)
    await game.advance(seconds=0.5)
    assert player.get(Character).vehicle is None
    assert player.get(Animator).state == "move"
    local = car.transform.to_local(player.transform.position)
    half_width = car.get(Collider).size.x / 2
    assert -half_width - 1.5 < local.x < -half_width, "beside the driver's door, clear of the body"
    assert abs(local.z - seat.z) < 0.6
    assert player.get(Character).grounded and abs(local.y) < 0.3, "standing on the ground"


@playtest("hurting someone draws a star; staying out of sight ends the pursuit")
async def test_wanted_and_escape(game: GameHarness):
    await game.start(scene=Scenes.sunset_bay, seed=11)
    player = game.world.placed(Placed.player)
    walker = game.world.placed(Placed.harbor_walker_1)
    walker.transform.position = player.transform.position + vec3(0, 0, 1)
    await game.press(OnFootControls.fire)
    await game.advance(frames=2)
    wanted = game.get(Wanted)
    assert wanted_level(wanted) >= 1 and wanted.phase is Phase.CHASE

    rules = game.config(Pursuit)
    player.get(Character).teleport(game.world.placement(Placed.canal_bay).position)
    await game.advance(seconds=rules.search_after + 0.5)
    assert wanted.phase is Phase.SEARCH
    await game.advance_until(lambda: wanted.phase is Phase.CALM, timeout=rules.lose_after)
    assert wanted_level(wanted) == 0


@playtest("Lights out (death) costs a tenth of the cash and wakes you at the safehouse")
async def test_wasted(game: GameHarness):
    await game.start(scene=Scenes.sunset_bay, seed=11)
    player = game.world.placed(Placed.player)
    player.transform.position = vec3(-200, 1, -150)
    player.get(Health).kill()
    rules = game.config(StreetRules)
    await game.advance(seconds=rules.wasted_seconds + 0.5)
    assert game.get(Wallet).cash == 450
    assert not player.get(Health).dead
    assert player.transform.position.distance_to(game.world.placement(rules.respawn).position) < 0.5


@playtest("the corner map opens into the full map on M, and a parked compact is a car you can steal")
async def test_minimap_and_compact(game: GameHarness):
    await game.start(scene=Scenes.sunset_bay, seed=11)
    await game.advance(frames=2)
    assert game.is_open(MapCorner) and not game.is_open(MapScreen)
    assert game.panel_state(MapCorner)["route_image"].startswith("data:image/svg+xml,")
    await game.press(MapControls.map)
    await game.advance(frames=2)
    minimap = game.world.placed(Placed.player).get(Minimap)
    assert game.is_open(MapScreen) and minimap.range == game.config(MapScreenConfig).map_range
    await game.press(MapControls.map)
    await game.advance(frames=2)
    assert game.is_open(MapCorner) and not game.is_open(MapScreen)
    player = game.world.placed(Placed.player)
    compact = game.world.placed(Placed.harbor_compact)
    assert compact.has(CarCondition)
    player.transform.position = compact.transform.position + vec3(2, 0, 0)
    await game.advance(frames=2)
    await game.press(OnFootControls.enter)
    await game.advance(frames=2)
    assert player.get(Character).vehicle == compact
    assert len(game.emitted(CrimeCommitted)) == 1


@playtest("the city's traffic fills in around the player and keeps to its lanes; taking a car is theft")
async def test_traffic(game: GameHarness):
    await game.start(scene=Scenes.sunset_bay, seed=11)
    player = game.world.placed(Placed.player)
    street = game.ctx.city.nearest_road(vec3(380, 0, 330)).point
    player.get(Character).teleport(game.ctx.city.sidewalk_point(street) or street)
    await game.advance_until(lambda: game.world.query(CityCar).count() >= 4, timeout=20)
    await game.advance(seconds=4)
    traffic = [(car, city_car) for car, city_car in game.world.query(CityCar) if city_car.state == "driving"]
    assert traffic and any(city_car.speed > 2 for _, city_car in traffic)
    for car, _ in traffic:
        road = game.ctx.city.nearest_road(car.transform.position)
        assert road.distance <= road.width / 2 + 1, "every city car is on a street"
    # A car with no other vehicle beside it (parked cars line the kerb), entered from the street side.
    def alone(car):
        return game.world.query(Vehicle).near(car.transform.position, 7).count() == 1
    car = next(car for car, _ in traffic if car.has(Vehicle) and car.has(CarCondition) and alone(car))
    player.get(Character).teleport(car.transform.position - car.transform.right * 2.5)
    await game.press(OnFootControls.enter)
    await game.advance(frames=2)
    assert player.get(Character).vehicle == car and car.get(CityCar).state == "released"
    assert Content.crime.car_theft in [e.crime for e in game.emitted(CrimeCommitted)]


@playtest("the title's Play picks up the safehouse save")
async def test_play_continues(game: GameHarness):
    await game.start(scene=Scenes.sunset_bay, seed=11)
    await game.advance(frames=2)
    game.get(Wallet).cash = 1234
    game.ctx.save.save("auto")
    game.ctx.scenes.load(Scenes.title)
    await game.advance(frames=3)
    assert game.is_open(TitleScreen)
    await game.click(TitleScreen, "play")
    await game.advance(frames=3)
    assert game.ctx.scenes.current_is(Scenes.sunset_bay)
    assert game.get(Wallet).cash == 1234
    hud = game.panel_state(Hud)
    assert hud["cash"] == 1234 and not hud["car"]["driving"] and not hud["job"]["active"]


@playtest("the weapon wheel draws an owned weapon and refuses one Sam doesn't have")
async def test_weapon_wheel(game: GameHarness):
    await game.start(scene=Scenes.sunset_bay, seed=11)
    await game.advance(frames=2)
    arsenal = game.world.placed(Placed.player).get(Arsenal)
    assert arsenal.current == Content.weapon.fists
    await game.hold(RadialControls.wheel)
    await game.advance(frames=2)
    assert game.is_open(RadialMenu)
    await game.click(RadialMenu, "pick", option=Content.radial_option.pistol)
    await game.release(RadialControls.wheel)
    await game.advance(frames=2)
    assert arsenal.current == Content.weapon.pistol
    await game.hold(RadialControls.wheel)
    await game.advance(frames=2)
    await game.click(RadialMenu, "pick", option=Content.radial_option.shotgun)
    await game.release(RadialControls.wheel)
    await game.advance(frames=2)
    assert arsenal.current == Content.weapon.pistol


@playtest("C behind a parked car crouches into cover, and the police's line of fire hits the car")
async def test_cover(game: GameHarness):
    await game.start(scene=Scenes.sunset_bay, seed=11)
    player = game.world.placed(Placed.player)
    car = game.world.placed(Placed.parked_sedan)
    body = player.get(Character)
    beside = car.transform.position - car.transform.right * 1.6
    body.teleport(beside.with_y(game.ctx.terrain.height_at(beside) + 0.1),
                  yaw=heading_to(beside, car.transform.position))
    await game.advance(seconds=1)
    muzzle = car.transform.position + car.transform.right * 12 + vec3(0, 10, 0)  # an officer up on a bank
    shooter = game.world.placed(Placed.harbor_walker_1)
    assert line_of_fire(game.ctx, shooter, muzzle, player)
    await game.press(OnFootControls.cover)
    await game.advance(frames=3)
    assert body.stance == "crouch"
    assert not line_of_fire(game.ctx, shooter, muzzle, player)
    await game.press(OnFootControls.cover)
    await game.advance(frames=3)
    assert body.stance == "stand"


@playtest("the title has no player: the job keys' condition reads no car instead of failing")
async def test_title_without_player(game: GameHarness):
    await game.start(scene=Scenes.title)
    await game.advance(frames=3)
    assert player_car(game.ctx) is None
