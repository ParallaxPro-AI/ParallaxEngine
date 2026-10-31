"""Kills, gear drops, falling and rising."""

from parallax import vec3
from parallax.combat import Health
from parallax.test import GameHarness, playtest
from project import Content, Placed, Scenes

from features.combat.feature import Telegraph
from features.hero.feature import HeroControls, HeroCurve, Progression, rise_point
from features.inventory.feature import Gear, Purse, Slot
from tests.walkthrough import open_chapter


@playtest("a raider pays gold and experience and drops the first gear piece")
async def test_raider_bounty(game: GameHarness):
    await game.start(scene=Scenes.sundermere, seed=3)
    await open_chapter(game, Content.quest.goblin_menace)
    hero = game.world.placed(Placed.hero)
    raider = game.world.placed(Placed.caravan_raider_west)
    raider.get(Health).kill(source=hero)
    await game.advance(frames=2)
    assert game.get(Purse).gold >= 5
    assert game.get(Progression).xp >= 20
    assert Content.gear.raider_cleaver in game.get(Gear).owned
    assert game.get(Gear).worn[Slot.WEAPON] == Content.gear.raider_cleaver


@playtest("falling costs a tithe and the hero rises at the shrine")
async def test_fall_and_rise(game: GameHarness):
    await game.start(scene=Scenes.sundermere, seed=3)
    game.get(Purse).gold = 200
    hero = game.world.placed(Placed.hero)
    hero.transform.position = vec3(30, 8, -20)
    hero.get(Health).kill()
    await game.advance(seconds=game.config(HeroCurve).respawn_seconds + 0.5)
    assert not hero.get(Health).dead
    assert game.get(Purse).gold == 170
    shrine = game.world.placement(Placed.village_shrine).position
    assert hero.transform.position.distance_to(rise_point(game.ctx)) < 0.5
    assert (hero.transform.position - shrine).flat().length() < 2
    assert abs(hero.transform.position.y - shrine.y) < 0.5


@playtest("a dodge timed to the tell passes through the blow")
async def test_dodge(game: GameHarness):
    await game.start(scene=Scenes.sundermere, seed=3)
    await open_chapter(game, Content.quest.goblin_menace)
    hero = game.world.placed(Placed.hero)
    raider = game.world.placed(Placed.caravan_raider_east)
    hero.transform.position = raider.transform.position + vec3(0, 0, 2)
    health = hero.get(Health)
    await game.advance_until(lambda: game.world.query(tagged=Telegraph).count() > 0, timeout=6)
    await game.advance(seconds=Content.attack.raider_slash.data.tell - 0.2)
    await game.press(HeroControls.dodge)
    await game.advance(seconds=0.5)
    assert health.current == health.max
