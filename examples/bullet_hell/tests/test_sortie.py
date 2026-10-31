from parallax import Vec2, vec2
from parallax.combat import Health
from parallax.test import GameHarness, playtest
from project import Content, Prefabs, Scenes

from game.actions import Controls
from game.build import find_wisp
from game.components import Drift, Guardian, Petal, Spark, Wisp
from game.glyphs import GLYPHS
from game.resources import Best, Run, Shrine, Spawner
from game.ui import Hud, PauseMenu, ResultPanel, ShrinePanel, TitleScreen


def petal_near_wisp(game: GameHarness, offset: Vec2):
    at = find_wisp(game.ctx).transform.position.xy() + offset
    game.world.spawn(Prefabs.petal, at=at, components=[Drift()])


@playtest("the Wisp fires on its own")
async def test_auto_fire(game):
    await game.start(scene=Scenes.garden, seed=1)
    await game.advance(seconds=0.5)
    assert game.world.query(Spark).count() > 0


@playtest("a petal on the hitbox costs a petal, then i-frames protect the Wisp")
async def test_hit_and_iframes(game):
    await game.start(scene=Scenes.garden, seed=2)
    petal_near_wisp(game, Vec2.ZERO)
    await game.advance(frames=2)
    health = find_wisp(game.ctx).get(Health)
    assert health.current == 2
    assert health.invulnerable
    petal_near_wisp(game, Vec2.ZERO)
    await game.advance(frames=2)
    assert health.current == 2


@playtest("skimming a petal grazes it once and banks Spirit")
async def test_graze(game):
    await game.start(scene=Scenes.garden, seed=3)
    petal_near_wisp(game, vec2(0.5, 0))
    await game.advance(frames=3)
    wisp = find_wisp(game.ctx)
    assert game.get(Run).graze == 1
    assert wisp.get(Wisp).spirit == 1
    assert wisp.get(Health).current == 3


@playtest("a bomb clears every petal")
async def test_bomb(game):
    await game.start(scene=Scenes.garden, seed=4)
    petal_near_wisp(game, vec2(-2, 3))
    petal_near_wisp(game, vec2(2, 3))
    await game.press(Controls.bomb)
    await game.advance(frames=2)
    assert game.world.query(Petal).count() == 0
    assert find_wisp(game.ctx).get(Wisp).bombs == 1


@playtest("clearing a wave opens the shrine, and the pick joins the build")
async def test_shrine(game):
    await game.start(scene=Scenes.garden, seed=5)
    await game.advance_until(lambda: game.get(Spawner).sent == 5, timeout=10)
    for _, _, health in game.world.query(Guardian, Health):
        health.kill()
    await game.advance_until(lambda: game.is_open(ShrinePanel), timeout=5)

    offered = game.get(Shrine).offer[0]
    card = game.panel_state(ShrinePanel)["options"][0]
    assert card["glyph"] == GLYPHS[offered.id] and card["level"] == f"1/{offered.data.max_stacks}"
    await game.click(ShrinePanel, "choose", upgrade=offered.id)
    await game.advance(frames=2)
    assert game.get(Shrine).taken == [offered]
    assert game.get(Run).wave_index == 1
    assert not game.is_open(ShrinePanel)


@playtest("Thick Stem raises max petals through a modifier and mends one")
async def test_attunement_modifies_health(game):
    await game.start(scene=Scenes.garden, seed=8)
    health = find_wisp(game.ctx).get(Health)
    health.damage(1)
    game.get(Shrine).offer = [Content.upgrade.thick_stem]
    await game.advance(frames=1)
    assert game.is_open(ShrinePanel)
    await game.click(ShrinePanel, "choose", upgrade=Content.upgrade.thick_stem.id)
    await game.advance(frames=2)
    assert health.max == 4
    assert health.current == 3


@playtest("losing the last petal ends the sortie; retry counts a new run")
async def test_defeat_and_retry(game):
    await game.start(scene=Scenes.garden, seed=6)
    runs = game.get(Best).runs
    find_wisp(game.ctx).get(Health).kill()
    await game.advance(frames=2)
    assert game.is_open(ResultPanel)
    assert not game.get(Run).won

    await game.click(ResultPanel, "retry")
    await game.advance(frames=2)
    assert not game.is_open(ResultPanel)
    assert find_wisp(game.ctx).get(Health).current == 3
    assert game.get(Best).runs == runs + 1


@playtest("the pause key toggles the pause menu")
async def test_pause(game):
    await game.start(scene=Scenes.garden, seed=7)
    await game.press(Controls.pause)
    assert game.is_open(PauseMenu)
    await game.press(Controls.pause)
    assert not game.is_open(PauseMenu)


@playtest("felling the Thornmother wins the sortie; Again starts over at wave 1")
async def test_victory_and_again(game):
    await game.start(scene=Scenes.title, seed=9)
    await game.click(TitleScreen, "start")
    await game.advance(frames=2)
    hud = game.panel_state(Hud)
    assert hud["waves"] == 9 and hud["wave"] == 1
    assert [len(act["pips"]) for act in hud["acts"]] == [3, 3, 3]
    assert [pip["boss"] for act in hud["acts"] for pip in act["pips"]] == [False] * 8 + [True]
    assert hud["banner_on"] and hud["banner"]["wave"] and hud["banner"]["kick"] == "WAVE 1 —"

    for _, _, health in game.world.query(Guardian, Health):
        health.kill()
    run = game.get(Run)
    run.wave_index, run.waves_cleared = 7, 8
    game.get(Shrine).offer = [Content.upgrade.quickpetal]
    await game.advance(frames=1)
    await game.click(ShrinePanel, "choose", upgrade=Content.upgrade.quickpetal.id)
    await game.advance_until(lambda: game.world.query(Guardian).count() == 1, timeout=5)
    assert game.panel_state(Hud)["has_boss"]
    assert game.panel_state(Hud)["boss_max"] == 110

    for _, _, health in game.world.query(Guardian, Health):
        health.kill()
    await game.advance_until(lambda: game.is_open(ResultPanel), timeout=5)
    result = game.panel_state(ResultPanel)
    assert not result["lost"] and result["title"] == "Garden Stilled"
    assert result["build"] == [{"label": "Quickpetal"}]
    assert game.get(Best).victories == 1

    await game.click(ResultPanel, "retry")
    await game.advance(frames=2)
    assert not game.is_open(ResultPanel)
    assert game.get(Run).wave_index == 0 and game.get(Run).score == 0
    assert game.get(Best).victories == 1
