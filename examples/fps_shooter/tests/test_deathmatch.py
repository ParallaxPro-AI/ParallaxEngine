from parallax import Model, Vec3
from parallax.characters import Character
from parallax.combat import Health
from parallax.test import GameHarness, playtest
from parallax.viewmodel import Viewmodel
from project import Content, Prefabs, Scenes

from game.actions import FpsControls
from game.components import Arsenal, Bot, Plating, Player, SmokeCloud
from game.events import FragScored, ShotFired
from game.gunplay import smoke_between
from game.resources import FeedKind, Match, Mods, Phase
from game.ui import PauseMenu, RunOver, TitleScreen, UpgradeChoice


async def deploy(game: GameHarness) -> None:
    await game.start(scene=Scenes.title)
    await game.click(TitleScreen, "start")


def hands(game: GameHarness) -> Viewmodel:
    return game.ctx.camera.main.entity.child("hands").get(Viewmodel)


def you(game: GameHarness):
    return game.world.query(tagged=Player).single()


async def frag_a_bot(game: GameHarness) -> None:
    # Four bots, each back bot_respawn_delay after its frag: the fifth frag waits for one.
    await game.advance_until(lambda: game.world.query(Bot).first() is not None, timeout=5)
    bot, _ = game.world.query(Bot).first()
    bot.get(Health).kill(source=you(game))
    await game.advance(frames=1)


@playtest("round one fields four grunts; holding the trigger empties the carbine into a reload")
async def round_one(game: GameHarness):
    await deploy(game)
    assert game.world.query(Bot).count() == 4
    grunt, _ = game.world.query(Bot).first()
    assert grunt.get(Model).options == {"headgear": "helmet", "gear": "full", "jacket": "olive", "trousers": "olive"}, \
        "archetypes dress the soldier model"
    # 30 rounds at 0.1 s is 3 s on paper; frame-summed time can land a shot a frame
    # late, so hold long enough to empty the magazine (the 2 s reload caps it at 30).
    await game.hold(FpsControls.fire, 4)
    assert len([shot for shot in game.emitted(ShotFired) if shot.shooter.has(Player)]) == 30
    assert you(game).get(Arsenal).reload_done_at >= 0, "an empty magazine reloads by itself"
    await game.advance(seconds=2)
    assert you(game).get(Arsenal).reserve[Content.weapon.carbine] == 90


@playtest("the pause key only exists in the arena")
async def pause_is_arena_only(game: GameHarness):
    await game.start(scene=Scenes.title)
    await game.press(FpsControls.pause)
    assert not game.is_open(PauseMenu)
    await game.click(TitleScreen, "start")
    await game.press(FpsControls.pause)
    assert game.is_open(PauseMenu)


@playtest("number keys pick a weapon slot")
async def weapon_slots(game: GameHarness):
    await deploy(game)
    await game.press_index(FpsControls.weapon_slot, 1)
    assert you(game).get(Arsenal).current == 1
    assert hands(game).item == Prefabs.sniper_view, "the held gun follows the slot"
    await game.press_index(FpsControls.weapon_slot, 2)
    assert you(game).get(Arsenal).current == 2
    assert hands(game).item is None, "grenades are thrown from empty hands"


@playtest("plating soaks 45% of a hit until it runs out")
async def plating(game: GameHarness):
    await deploy(game)
    you(game).get(Plating).points = 10
    you(game).get(Health).damage(40)
    assert you(game).get(Plating).points == 0
    assert you(game).get(Health).current == 90, "10 soaked, 30 taken"


@playtest("a frag scores, starts a streak, and the bot comes back")
async def frag(game: GameHarness):
    await deploy(game)
    await frag_a_bot(game)
    match = game.get(Match)
    assert (match.frags, match.streak, match.score) == (1, 1, 100)
    assert game.emitted(FragScored)[-1].streak == 1
    line = match.feed[-1]
    assert (line.text, line.kind, line.points) == ("Grunt down", FeedKind.KILL, 100), "the HUD's centre feed"
    await game.advance(seconds=3.1)
    assert game.world.query(Bot).count() == 4


@playtest("reaching the frag target deals upgrade cards; the one kept applies")
async def upgrade(game: GameHarness):
    await deploy(game)
    for _ in range(5):
        await frag_a_bot(game)
    assert game.is_open(UpgradeChoice)
    card = game.get(Match).offer[0]
    await game.click(UpgradeChoice, "pick", upgrade=card.id)
    assert not game.is_open(UpgradeChoice)
    assert game.get(Match).round == 1
    assert game.get(Mods).damage_dealt_mul == card.data.damage_dealt_mul


@playtest("losing every life ends the run")
async def out_of_lives(game: GameHarness):
    await deploy(game)
    while not game.is_open(RunOver):
        you(game).get(Health).kill()
        await game.advance(seconds=3)
    assert game.get(Match).phase is Phase.LOST


@playtest("a smoke grenade's cloud blocks the line between a bot and you until it clears")
async def smoke(game: GameHarness):
    await deploy(game)
    await game.press_index(FpsControls.weapon_slot, 2)
    assert you(game).get(Arsenal).current == 2
    await game.press(FpsControls.fire)
    await game.advance(seconds=2)
    cloud, _ = game.world.query(SmokeCloud).first()
    center = cloud.transform.position + Vec3(0, 1.4, 0)
    ctx = game.ctx
    assert smoke_between(ctx, center + Vec3(-10, 0, 0), center + Vec3(10, 0, 0))
    assert not smoke_between(ctx, center + Vec3(-10, 0, 8), center + Vec3(10, 0, 8))
    await game.advance(seconds=9)
    assert game.world.query(SmokeCloud).count() == 0


@playtest("C toggles crouch")
async def crouch(game: GameHarness):
    await deploy(game)
    await game.press(FpsControls.crouch)
    await game.advance(frames=2)
    assert you(game).get(Character).stance == "crouch"
    await game.press(FpsControls.crouch)
    await game.advance(frames=2)
    assert you(game).get(Character).stance == "stand"


@playtest("holding E on a cover crate finds spare rifle rounds, once")
async def search_crate(game: GameHarness):
    await deploy(game)
    arsenal = you(game).get(Arsenal)
    before = arsenal.reserve[Content.weapon.carbine]
    you(game).get(Character).teleport(Vec3(-4.5, 0, -34))
    await game.advance(frames=2)
    await game.hold(FpsControls.interact, 0.8)
    assert arsenal.reserve[Content.weapon.carbine] == before + 12
    await game.hold(FpsControls.interact, 0.8)
    assert arsenal.reserve[Content.weapon.carbine] == before + 12, "each crate is searched once"


@playtest("the sniper's scope toggles on a press: it stays up after release and drops on the next press")
async def scope_toggles(game: GameHarness):
    await deploy(game)
    await game.press_index(FpsControls.weapon_slot, 1)
    await game.advance(frames=2)
    await game.press(FpsControls.zoom)
    await game.advance(frames=10)
    assert you(game).get(Arsenal).zoomed, "the scope stays up with the button released"
    await game.press(FpsControls.zoom)
    await game.advance(frames=2)
    assert not you(game).get(Arsenal).zoomed
