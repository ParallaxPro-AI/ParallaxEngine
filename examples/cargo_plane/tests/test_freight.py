from parallax import Marker, Vec2, Vec3
from parallax.characters import Character
from parallax.physics import Rigidbody
from parallax.test import playtest
from parallax.vehicles import Vehicle
from project import Content, Placed, Scenes

from game.actions import Controls, FlightControls, WalkControls
from game.components import Plane
from game.config import FreightRules
from game.content import IslandDef
from game.events import CargoDelivered, PlaneLost
from game.feed import Feed, Kind
from game.resources import Board, Career
from game.rules import depot, flown, pilot
from game.ui import FlightHud, GameOverPanel, OfficePanel, PauseMenu, PauseSettings

OPEN_SEA = Vec3(-600, 40, -600)


def pad(game, island):
    return depot(game.ctx, island).transform.position


def home_plane(game):
    return game.ctx.world.placed(Placed.plane)


def shown_beacon(game):
    """The one beacon whose HUD marker is up (the marker rides its child "tag")."""
    tag, _ = game.world.query(Marker).where(lambda e, marker: marker.shown).single()
    return tag.parent


async def board_the_plane(game):
    await game.press(Controls.interact)
    assert flown(game.ctx) == home_plane(game)


@playtest("a new career starts at home with a job signed and a plane parked on every island")
async def test_new_career(game):
    await game.start(scene=Scenes.archipelago)
    board = game.get(Board)
    assert board.island == game.config(FreightRules).home
    assert board.contract is not None and not board.loaded
    assert game.get(Career).airframes_lost == 0
    assert game.world.query(tagged=Plane).count() == len(game.ctx.content(IslandDef))


@playtest("the pilot boards, opens the throttle and gets airborne off the home strip")
async def test_takeoff(game):
    await game.start(scene=Scenes.archipelago)
    await board_the_plane(game)
    await game.move(FlightControls.power, Vec2(0, 1), seconds=2)
    await game.move(FlightControls.stick, Vec2(0, 0.6), seconds=12)
    assert home_plane(game).get(Vehicle).airborne


@playtest("walking onto the home pad loads the signed job and starts its clock")
async def test_loading_on_foot(game):
    await game.start(scene=Scenes.archipelago)
    pilot(game.ctx).get(Character).teleport(pad(game, game.config(FreightRules).home) + Vec3(0, 1, 0))
    await game.advance(seconds=1)
    assert game.get(Board).loaded
    assert game.get(Board).time_left > 0


@playtest("landing the load on the destination pad pays out and deals a new board there")
async def test_delivery(game):
    await game.start(scene=Scenes.archipelago)
    await board_the_plane(game)
    contract = game.get(Board).contract
    aircraft = home_plane(game)
    aircraft.get(Rigidbody).teleport(pad(game, contract.origin) + Vec3(0, 2, 0))
    await game.advance(seconds=1)
    aircraft.get(Rigidbody).teleport(pad(game, contract.destination) + Vec3(0, 2, 0))
    await game.advance(seconds=1)
    assert game.emitted(CargoDelivered)
    assert game.get(Career).money >= contract.pay
    assert game.get(Board).island == contract.destination
    assert any(line.kind is Kind.GOOD for line in game.get(Feed).lines)


@playtest("coming down on the sea costs an airframe and the plane waits back on the home strip")
async def test_ditching(game):
    await game.start(scene=Scenes.archipelago)
    home_plane(game).get(Rigidbody).teleport(OPEN_SEA)
    lost = await game.until(PlaneLost, timeout=6)
    assert lost.ditched
    assert game.get(Career).airframes_lost == 1
    assert home_plane(game).transform.position.y > game.config(FreightRules).water_level
    assert any(line.kind is Kind.BAD for line in game.get(Feed).lines)


@playtest("losing every airframe ends the career")
async def test_grounded(game):
    await game.start(scene=Scenes.archipelago)
    game.get(Career).airframes_lost = game.config(FreightRules).start_airframes - 1
    home_plane(game).get(Rigidbody).teleport(OPEN_SEA)
    await game.until(PlaneLost, timeout=6)
    await game.advance(frames=2)
    assert game.is_open(GameOverPanel)


@playtest("the office opens beside the pad and signs a contract from the board")
async def test_office(game):
    await game.start(scene=Scenes.archipelago)
    pilot(game.ctx).get(Character).teleport(pad(game, Content.island.harbor_base) + Vec3(-40, 1, 0))
    await game.press(Controls.office)
    assert game.is_open(OfficePanel)
    await game.click(OfficePanel, "take", offer=2)
    assert game.get(Board).contract == game.get(Board).offers[2]


@playtest("the pause key opens the pause menu, its Settings view opens over it, and P closes it")
async def test_pause_toggles(game):
    await game.start(scene=Scenes.archipelago)
    await game.press(Controls.pause)
    assert game.is_open(PauseMenu)
    await game.click(PauseMenu, "settings")
    assert game.is_open(PauseSettings)
    await game.click(PauseSettings, "back")
    assert not game.is_open(PauseSettings)
    await game.press(Controls.pause)
    assert not game.is_open(PauseMenu)


@playtest("the pause menu and its key don't exist on the title screen")
async def test_no_pause_on_title(game):
    await game.start(scene=Scenes.title)
    await game.press(Controls.pause)
    assert not game.is_open(PauseMenu)


@playtest("the islands are ground: every depot pad stands on its island's runway flat, above the sea")
async def test_islands_are_terrain(game):
    await game.start(scene=Scenes.archipelago)
    rules = game.config(FreightRules)
    for island in game.ctx.content(IslandDef):
        at = pad(game, island)
        ground = game.ctx.terrain.height_at(at)
        assert abs(ground - 5) < 0.5, (island.id, ground)
        assert ground > rules.water_level
    assert game.ctx.terrain.height_at(OPEN_SEA) < rules.water_level


@playtest("the amber pickup beacon stands on the job's origin, then the green drop-off beacon on its destination")
async def test_beacons(game):
    await game.start(scene=Scenes.archipelago)
    await game.advance(frames=2)
    board = game.get(Board)
    assert shown_beacon(game).transform.position.distance_to(pad(game, board.contract.origin)) < 0.5
    pilot(game.ctx).get(Character).teleport(pad(game, board.contract.origin) + Vec3(0, 1, 0))
    await game.advance(seconds=1)
    assert shown_beacon(game).transform.position.distance_to(pad(game, board.contract.destination)) < 0.5


@playtest("in the cockpit the HUD reads out the instruments and the prompt to step out")
async def test_cockpit_readout(game):
    await game.start(scene=Scenes.archipelago)
    await board_the_plane(game)
    await game.advance(seconds=1)
    hud = game.panel_state(FlightHud)
    assert hud["flying"]
    assert hud["phase"] == "parked"
    assert hud["prompt"] == "Exit plane"
    assert hud["obj_tag"] == "PICKUP"


def camera_flat_forward(game):
    return game.ctx.camera.main.relative(Vec2(0, 1)).normalized()


@playtest("on foot W walks away from the orbit camera and A/D strafe without turning it")
async def test_walk_relative_to_camera(game):
    await game.start(scene=Scenes.archipelago)
    walker = pilot(game.ctx)
    walker.get(Character).teleport(pad(game, game.config(FreightRules).home) + Vec3(0, 1, 0))
    await game.advance(seconds=1)
    forward = camera_flat_forward(game)
    right = game.ctx.camera.main.relative(Vec2(1, 0)).normalized()
    start = walker.transform.position
    await game.move(WalkControls.move, Vec2(0, 1), seconds=1)
    walked = walker.transform.position - start
    assert walked.dot(forward) > 2, walked
    assert camera_flat_forward(game).dot(forward) > 0.99

    for sign, axis in ((1, Vec2(1, 0)), (-1, Vec2(-1, 0))):
        before = camera_flat_forward(game)
        start = walker.transform.position
        await game.move(WalkControls.move, axis, seconds=1)
        walked = walker.transform.position - start
        assert walked.dot(right) * sign > 2, walked
        assert abs(walked.dot(forward)) < walked.length() * 0.5, walked
        assert camera_flat_forward(game).dot(before) > 0.99


@playtest("the pilot is hidden while flying and shown again after stepping out")
async def test_pilot_hidden_in_cockpit(game):
    await game.start(scene=Scenes.archipelago)
    walker = pilot(game.ctx)
    assert walker.visible
    await board_the_plane(game)
    await game.advance(seconds=0.2)
    assert not walker.visible
    await game.press(Controls.interact)
    await game.advance(seconds=0.2)
    assert flown(game.ctx) is None
    assert walker.visible
