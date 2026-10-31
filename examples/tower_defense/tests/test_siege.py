from parallax import vec3
from parallax.combat import Health, StatusEffects
from parallax.test import GameHarness, playtest
from project import Content, Scenes

from game.actions import SiegeControls
from game.components import BuildPad, Invader, Turret
from game.events import WaveCleared
from game.resources import Campaign, Purse, Result, Siege
from game.battlefield_map import is_unlocked
from game.siege import wave_in_progress
from game.ui import Hud, LevelSelect, PauseMenu, ResultScreen, TitleScreen


async def start_meadow(game: GameHarness) -> None:
    await game.start(scene=Scenes.level_select)
    await game.click(TitleScreen, "start")
    await game.click(LevelSelect, "enter", level=Content.level.meadow.id)


@playtest("an arrow tower clears the first wave and pays out")
async def first_wave(game: GameHarness):
    await start_meadow(game)
    await game.tap_entity(game.world.query(tagged=BuildPad).nearest(vec3(-15, 0, -1)))
    await game.click(Hud, "choose_tower", tower=Content.tower.arrow.id)
    assert game.world.query(Turret).count() == 1
    assert game.get(Purse).gold == 400

    await game.click(Hud, "send_wave")
    await game.advance_until(lambda: len(game.emitted(WaveCleared)) == 1, timeout=60)
    assert game.get(Purse).gold > 400, "bounties, the clear bonus and interest were paid"


@playtest("armor blunts every hit to at least 1; venom ticks ignore it")
async def armor(game: GameHarness):
    await start_meadow(game)
    await game.click(Hud, "send_wave")
    await game.advance_until(lambda: game.world.query(Invader).count() > 0)
    enemy, _, health = game.world.query(Invader, Health).first()
    health.flat_armor = 5
    health.damage(3)
    assert health.current == health.max - 1, "combat(min_damage=1)"
    enemy.get(StatusEffects).apply(Content.status_effect.venom, 1, strength=12)
    await game.advance(seconds=1)
    assert health.current == health.max - 1 - 12


@playtest("a weaker chill doesn't replace a stronger one")
async def strongest_chill(game: GameHarness):
    await start_meadow(game)
    await game.click(Hud, "send_wave")
    await game.advance_until(lambda: game.world.query(Invader).count() > 0)
    enemy, invader = game.world.query(Invader).first()
    walking = invader.speed
    effects = enemy.get(StatusEffects)
    effects.apply(Content.status_effect.chill, 2, strength=0.65)
    effects.apply(Content.status_effect.chill, 2, strength=0.5)
    assert effects.strength(Content.status_effect.chill) == 0.65
    assert abs(invader.speed - walking * 0.35) < 1e-6


@playtest("Start Siege leaves the title for the campaign map, and Back returns to it")
async def title_and_map(game: GameHarness):
    await game.start(scene=Scenes.level_select)
    assert game.is_open(TitleScreen) and not game.is_open(LevelSelect)
    await game.click(TitleScreen, "start")
    assert game.is_open(LevelSelect) and not game.is_open(TitleScreen)
    await game.click(LevelSelect, "back")
    assert game.is_open(TitleScreen)


@playtest("the pause key only exists on the battlefields")
async def pause_scope(game: GameHarness):
    await game.start(scene=Scenes.level_select)
    await game.press(SiegeControls.pause)
    assert not game.is_open(PauseMenu)
    await game.click(TitleScreen, "start")
    await game.click(LevelSelect, "enter", level=Content.level.meadow.id)
    await game.press(SiegeControls.pause)
    assert game.is_open(PauseMenu)


@playtest("upgrade then sell refunds half of everything spent")
async def upgrade_and_sell(game: GameHarness):
    await start_meadow(game)
    await game.tap_entity(game.world.query(tagged=BuildPad).first())
    await game.click(Hud, "choose_tower", tower=Content.tower.cannon.id)
    await game.click(Hud, "upgrade")
    _, turret = game.world.query(Turret).single()
    assert turret.level == 2
    assert game.get(Purse).gold == 500 - 200 - 150

    await game.click(Hud, "sell")
    await game.advance(frames=1)
    assert game.world.query(Turret).count() == 0
    assert game.get(Purse).gold == 150 + (200 + 150) // 2


@playtest("an empty battlefield is overrun")
async def overrun(game: GameHarness):
    await start_meadow(game)
    while not game.is_open(ResultScreen):
        await game.click(Hud, "send_wave")
        await game.advance(seconds=1)
        await game.advance_until(lambda: not wave_in_progress(game.ctx) or game.is_open(ResultScreen), timeout=120)
    assert game.get(Siege).result is Result.LOST


@playtest("the HUD shows banked interest and next-wave intel, then the live count")
async def hud_intel(game: GameHarness):
    await start_meadow(game)
    await game.advance(frames=2)
    state = game.panel_state(Hud)
    assert state["interest_text"] == "+40g", "8% of 500 gold"
    assert state["intel"] == [{"name": "Goblin", "count": 6}]
    await game.click(Hud, "send_wave")
    await game.advance_until(lambda: game.world.query(Invader).count() > 0)
    await game.advance(frames=2)
    state = game.panel_state(Hud)
    assert state["intel"] == [] and state["wave_status"].endswith("afield") and state["wave_status"] != "0 afield"


@playtest("clearing the last wave wins with three stars, unlocks the next battlefield, and Retry restarts")
async def win_and_retry(game: GameHarness):
    await start_meadow(game)
    game.get(Siege).wave = 9  # straight to the dragon wave
    await game.click(Hud, "send_wave")

    def slay() -> bool:
        for _, health in game.world.query(Health):
            if health.current > 0:
                health.damage(10_000)
        return game.is_open(ResultScreen)

    await game.advance_until(slay, timeout=120)
    siege = game.get(Siege)
    assert siege.result is Result.WON and siege.stars == 3
    assert siege.score == game.get(Purse).gold + 20 * 50 + 10 * 25
    assert game.get(Campaign).stars[Content.level.meadow] == 3
    assert is_unlocked(game.ctx, Content.level.desert)
    await game.click(ResultScreen, "retry")
    await game.advance(frames=2)
    assert game.get(Siege).wave == 0 and game.get(Purse).gold == 500 and game.get(Purse).lives == 20
