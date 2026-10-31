"""The opening of the main story, played through its real inputs, and the Shadow Rift."""

from parallax.combat import Health
from parallax.story import QuestCompleted, QuestStarted
from parallax.test import GameHarness, playtest
from project import Content, Placed, Scenes

from features.hero.feature import Progression
from features.inventory.feature import Purse
from features.quests.feature import Doom, Ending, Outcome, ShadowRift
from game.ui import GameOverScreen, TitleScreen
from tests.walkthrough import open_chapter, talk_to


@playtest("a new game opens the first chapter")
async def test_first_chapter(game: GameHarness):
    await game.start(scene=Scenes.sundermere, seed=7)
    assert [e.quest for e in game.emitted(QuestStarted)] == [Content.quest.welcome_hero]


@playtest("talking to the elder pays the first chapter and sends you to the caravan")
async def test_welcome_chain(game: GameHarness):
    await game.start(scene=Scenes.sundermere, seed=7)
    gold_before = game.get(Purse).gold
    await talk_to(game, Placed.elder_mirelle)
    await game.advance(frames=2)
    assert [e.quest for e in game.emitted(QuestCompleted)] == [Content.quest.welcome_hero]
    assert Content.quest.goblin_menace in [e.quest for e in game.emitted(QuestStarted)]
    assert game.get(Purse).gold == gold_before + Content.quest.welcome_hero.data.reward_gold
    assert game.get(Progression).xp > 0


@playtest("the last chapter opens the rift, and each fall burns time off its clock")
async def test_rift_feeds_on_falls(game: GameHarness):
    await game.start(scene=Scenes.sundermere, seed=7)
    await open_chapter(game, Content.quest.shadow_dungeon)
    rift = game.config(ShadowRift)
    clock = game.get(Doom).clock
    assert game.ctx.weather.preset == rift.weather
    before = clock.remaining
    game.world.placed(Placed.hero).get(Health).kill()
    await game.advance(frames=1)
    assert before - clock.remaining >= rift.death_penalty


@playtest("the sky darkens again over the rift's last minute")
async def test_rift_storm(game: GameHarness):
    await game.start(scene=Scenes.sundermere, seed=7)
    await open_chapter(game, Content.quest.shadow_dungeon)
    rift = game.config(ShadowRift)
    game.get(Doom).clock.tick(rift.duration - rift.storm_at + 1)
    await game.advance(frames=2)
    assert game.get(Doom).stormed
    assert game.ctx.weather.preset == rift.storm


@playtest("slaying Malakar wins the run, and Play again starts the story over")
async def test_victory_and_restart(game: GameHarness):
    await game.start(scene=Scenes.sundermere, seed=7)
    await open_chapter(game, Content.quest.shadow_dungeon)
    hero = game.world.placed(Placed.hero)
    game.world.placed(Placed.malakar).get(Health).kill(source=hero)
    await game.advance(frames=3)
    assert game.get(Outcome).ending is Ending.VICTORY
    assert game.is_open(GameOverScreen)
    assert not game.panel_state(GameOverScreen)["lost"]
    await game.click(GameOverScreen, "play_again")
    await game.advance(frames=3)
    assert game.get(Outcome).ending is Ending.NONE
    assert not game.is_open(GameOverScreen)
    assert game.ctx.story.quest(Content.quest.welcome_hero).status == "active"


@playtest("the title's one button walks the lantern road into the first chapter")
async def test_title_starts_the_story(game: GameHarness):
    await game.start(scene=Scenes.title, seed=7)
    assert game.is_open(TitleScreen)
    await game.click(TitleScreen, "start_game")
    await game.advance(frames=3)
    assert game.ctx.scenes.current_is(Scenes.sundermere)
    assert game.ctx.story.quest(Content.quest.welcome_hero).status == "active"
