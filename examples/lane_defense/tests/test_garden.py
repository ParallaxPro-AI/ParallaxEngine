from parallax import Model, Settings, vec2, vec3
from parallax.combat import Health
from parallax.test import GameHarness, playtest
from parallax.values import Cell
from project import Content, Scenes

from game.actions import GardenControls
from game.checkpoint import Checkpoint
from game.components import Husk, Planted
from game.lawn import lane_z, lawn
from game.resources import Campaign, GardenState, Planting, Pollen, Result, WaveState
from game.ui import PauseMenu, ResultScreen, TitleScreen


async def plant_with_keys(game: GameHarness, slot: int) -> None:
    """Arm a tray seed, step the keyboard cursor one cell right of its start, and plant."""
    await game.press_index(GardenControls.seed, slot)
    await game.move(GardenControls.cursor, vec2(1, 0), 0.1)
    await game.press(GardenControls.confirm)


@playtest("first lesson: one thornspitter routes the first shambler")
async def first_lesson(game: GameHarness):
    await game.start(scene=Scenes.title)
    await game.click(TitleScreen, "start")
    assert game.get(Pollen).amount == 200, "the scene loads with the garden's starting pollen"
    await game.advance(seconds=30)
    assert game.get(WaveState).wave == 0, "the first wave waits for a defender"
    banked = game.get(Pollen).amount
    assert banked > 200, "sky pollen motes drifted down and were gathered while waiting"

    await plant_with_keys(game, 0)
    assert lawn(game.ctx).first_at(Cell(2, 2)) is not None
    assert game.get(Pollen).amount == banked - 100, "the thornspitter costs 100 pollen"

    await game.advance_until(lambda: game.get(GardenState).kills >= 1, timeout=60)


@playtest("the trowel frees the cell and refunds half the seed")
async def dig_up(game: GameHarness):
    await game.start(scene=Scenes.title)
    await game.click(TitleScreen, "start")
    await plant_with_keys(game, 0)
    await game.press(GardenControls.dig)
    await game.press(GardenControls.confirm)
    await game.advance(frames=1)
    assert game.world.query(Planted).count() == 0
    assert lawn(game.ctx).first_at(Cell(2, 2)) is None
    assert game.get(Pollen).amount == 150


@playtest("the pause key only exists in the garden")
async def pause_scope(game: GameHarness):
    await game.start(scene=Scenes.title)
    await game.press(GardenControls.pause)
    assert not game.is_open(PauseMenu)
    await game.click(TitleScreen, "start")
    await game.press(GardenControls.pause)
    assert game.is_open(PauseMenu)


@playtest("an undefended second garden is overrun")
async def overrun(game: GameHarness):
    await game.start(scene=Scenes.title)
    game.get(Campaign).stars[Content.level.level_1] = 1
    await game.click(TitleScreen, "choose_level", level=Content.level.level_2.id)
    await game.click(TitleScreen, "start")
    await game.advance_until(lambda: game.is_open(ResultScreen), timeout=240)
    assert game.get(GardenState).result is Result.LOST


@playtest("a cleared first garden wins stars, opens the second and Next plants it")
async def full_garden_win(game: GameHarness):
    await game.start(scene=Scenes.title)
    await game.click(TitleScreen, "start")
    await plant_with_keys(game, 0)
    await game.advance_until(lambda: game.is_open(ResultScreen), timeout=180)
    garden = game.get(GardenState)
    assert garden.result is Result.WON
    assert garden.kills == 6, "three waves: 1 + 2 + 3 shamblers"
    assert garden.stars == 3, "no husk reached the house"
    assert game.get(Campaign).stars[Content.level.level_1] == 3
    await game.click(ResultScreen, "next")
    assert game.get(Campaign).level == Content.level.level_2
    assert game.get(GardenState).result is Result.PLAYING
    assert game.get(Pollen).amount == Content.level.level_2.data.start_pollen


@playtest("husks walk on their leg joints; reduced motion holds them still")
async def garden_characters(game: GameHarness):
    await game.start(scene=Scenes.title)
    await game.click(TitleScreen, "start")
    await plant_with_keys(game, 0)
    await game.advance_until(lambda: game.world.query(Husk).count() > 0, timeout=30)
    await game.advance(seconds=0.5)
    husk = next(entity for entity, _ in game.world.query(Husk))
    legs = husk.get(Model)
    first = legs.joint("leg_l")
    await game.advance(seconds=0.1)
    assert legs.joint("leg_l") != first, "the legs swing while it walks"
    assert abs(husk.transform.scale.x - 0.82) < 1e-6, "garden characters stand at 82 %"

    await game.press(GardenControls.pause)
    await game.click(PauseMenu, "toggle_motion")
    assert game.get(Settings).reduced_motion
    await game.click(PauseMenu, "resume")
    held = legs.joint("leg_l")
    await game.advance(seconds=0.3)
    assert legs.joint("leg_l") == held, "reduced motion: no joint animation"


@playtest("pausing mid-wave checkpoints the garden; Continue picks it up from there")
async def continue_mid_wave(game: GameHarness):
    await game.start(scene=Scenes.title)
    await game.click(TitleScreen, "start")
    await plant_with_keys(game, 0)
    await game.advance_until(lambda: game.world.query(Husk).count() > 0, timeout=30)
    await game.advance(seconds=2)
    _, husk = next(iter(game.world.query(Husk)))
    lane = husk.lane
    x = next(entity for entity, _ in game.world.query(Husk)).transform.position.x
    pollen, wave = game.get(Pollen).amount, game.get(WaveState).wave
    await game.press(GardenControls.pause)
    await game.click(PauseMenu, "quit")
    assert game.is_open(TitleScreen)

    await game.click(TitleScreen, "continue")
    await game.advance(frames=1)
    assert game.get(Pollen).amount == pollen
    assert game.get(WaveState).wave == wave
    assert lawn(game.ctx).first_at(Cell(2, 2)) is not None, "the thornspitter is back in its cell"
    husks = [(entity, h) for entity, h in game.world.query(Husk)]
    assert len(husks) == 1 and husks[0][1].lane == lane
    assert abs(husks[0][0].transform.position.x - x) < 0.2, "the husk resumes where it was"

    await game.advance_until(lambda: game.is_open(ResultScreen), timeout=180)
    assert game.get(GardenState).result is Result.WON
    await game.click(ResultScreen, "quit")
    assert game.get(Checkpoint).level is None, "a finished garden leaves nothing to continue"


@playtest("armored husks drop their armor below half health; the cursor keeps to open rows")
async def armor_and_cursor(game: GameHarness):
    await game.start(scene=Scenes.title)
    await game.click(TitleScreen, "start")
    tier = Content.husk.scrapmask
    husk = game.world.spawn(
        tier.data.prefab,
        at=vec3(6, 0, lane_z(game.ctx, 2)),
        components=[Husk(kind=tier, lane=2, speed=0), Health(current=tier.data.health, max=tier.data.health)],
    )
    await game.advance(frames=2)
    assert husk.get(Model).parts.get("armor", True), "armor on at full health"
    husk.get(Health).damage(tier.data.health * 0.6)
    await game.advance(frames=2)
    assert husk.get(Model).parts.get("armor") is False, "armor shed below half health"

    await game.move(GardenControls.cursor, vec2(0, 1), 0.1)
    assert game.get(Planting).cursor.row == 2, "garden 1 has only the middle row open"
