"""Playtests for an escape attempt."""

from parallax.test import GameHarness, playtest
from project import Content, Scenes

from game.actions import Controls
from game.components import Runner, Streamed
from game.config import Rules
from game.events import DistrictEntered, ObstacleHit, RunEnded, Stumbled
from game.resources import Profile, Run
from game.ui import RunOver, TitleScreen


@playtest("nobody moves during the count-in")
async def test_countdown(game: GameHarness):
    await game.start(scene=Scenes.street)
    await game.advance(seconds=game.config(Rules).countdown - 0.5)
    runner, _ = game.world.query(Runner).single()
    assert runner.transform.position.z == 0
    await game.advance(seconds=1)
    assert runner.transform.position.z > 0


@playtest("hits stumble the runner until the guard closes the gap")
async def test_busted(game: GameHarness):
    await game.start(scene=Scenes.street)
    await game.advance_until(lambda: game.is_open(RunOver), timeout=120)
    rules = game.config(Rules)
    assert not game.get(Run).won
    hits = len(game.emitted(ObstacleHit))
    allowed = int((rules.guard_follow - rules.guard_catch) / rules.guard_catch_up)
    assert len(game.emitted(Stumbled)) <= hits
    assert hits >= allowed  # recovery between hits can buy extra ones
    assert game.emitted(RunEnded)[-1].won is False


@playtest("changing lanes moves one lane at a time and stops at the kerb")
async def test_lanes(game: GameHarness):
    await game.start(scene=Scenes.street)
    await game.advance(seconds=game.config(Rules).countdown)
    for _ in range(3):
        await game.press(Controls.left)
    _, runner = game.world.query(Runner).single()
    assert runner.lane == 0


@playtest("a shield eats one hit")
async def test_shield(game: GameHarness):
    await game.start(scene=Scenes.street)
    game.get(Run).shields = 1
    gap = game.get(Run).guard_gap
    await game.advance_until(lambda: len(game.emitted(ObstacleHit)) == 1, timeout=60)
    await game.advance(frames=1)
    assert game.get(Run).shields == 0
    assert game.get(Run).guard_gap >= gap - 0.01


@playtest("the sprint board shows exactly while a sprint runs")
async def test_sprint_board(game: GameHarness):
    await game.start(scene=Scenes.street)
    await game.advance(seconds=game.config(Rules).countdown)
    runner, _ = game.world.query(Runner).single()
    assert not runner.child("board").visible
    game.get(Run).buffs[Content.powerup.sprint] = 1e9
    await game.advance(frames=1)
    assert runner.child("board").visible
    game.get(Run).buffs[Content.powerup.sprint] = 0
    await game.advance(frames=1)
    assert not runner.child("board").visible


@playtest("night shift stays locked until the first escape")
async def test_night_shift_lock(game: GameHarness):
    await game.start(scene=Scenes.title)
    await game.click(TitleScreen, "play", endless=True)
    await game.advance(frames=2)
    assert game.ctx.scenes.current_is(Scenes.street)
    assert not game.get(Run).endless
    assert not game.get(Profile).endless_unlocked


@playtest("crossing a district's end line hands over to the next district")
async def test_next_district(game: GameHarness):
    await game.start(scene=Scenes.street)
    await game.advance(seconds=game.config(Rules).countdown)
    run = game.get(Run)
    run.distance = run.district.data.end_distance
    await game.advance(frames=1)
    assert run.district == Content.district.neon_quay
    assert [e.district for e in game.emitted(DistrictEntered)] == [Content.district.neon_quay]


@playtest("Market Row is lined with buildings on both kerbs and its stalls")
async def test_market_row_dressing(game: GameHarness):
    await game.start(scene=Scenes.street)
    rules = game.config(Rules)
    market = Content.district.market_row.data
    stalls = [e for e in game.world.query(tagged=Streamed).entities() if e.prefab == market.landmark]
    houses = [e for e in game.world.query(tagged=Streamed).entities() if e.prefab in market.buildings]
    assert len(stalls) > 0
    assert any(e.transform.position.x < 0 for e in houses) and any(e.transform.position.x > 0 for e in houses)
    assert all(abs(abs(e.transform.position.x) - rules.building_offset) < 0.01 for e in houses)
