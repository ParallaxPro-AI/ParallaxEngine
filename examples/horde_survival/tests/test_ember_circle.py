"""Headless playtests (fixed seed, fixed timestep)."""

from parallax.combat import Health
from parallax.test import GameHarness, playtest
from project import Placed, Prefabs, Scenes

from game.actions import Controls
from game.components import Build, Horde, SoulMote
from game.events import RunEnded
from game.resources import Draft, Outcome, Records, Run
from game.ui import DraftPanel, Hud, PauseMenu, RunOverPanel, TitleScreen


async def start_run(game: GameHarness, seed: int = 0) -> None:
    await game.start(scene=Scenes.title)
    await game.click(TitleScreen, "start", seed=seed)
    await game.advance_until(lambda: game.world.query(Build).count() == 1)


@playtest("the first surge arrives and the staff starts killing on its own")
async def staff_kills_unaided(game: GameHarness):
    await start_run(game)
    await game.advance_until(lambda: game.world.query(tagged=Horde).count() > 0, timeout=5)
    await game.advance_until(lambda: game.get(Run).kills > 0, timeout=20)


@playtest("a typed seed replays the same arena and the same first surge")
async def seed_replays(game: GameHarness):
    async def first_surge(seed: int):
        await game.click(TitleScreen, "start", seed=seed)
        await game.advance_until(lambda: game.world.query(Build).count() == 1)
        await game.advance_until(lambda: game.world.query(tagged=Horde).count() > 0, timeout=5)
        return sorted((round(e.transform.position.x, 2), round(e.transform.position.z, 2))
                      for e in game.world.query(tagged=Horde))

    await game.start(scene=Scenes.title)
    first = await first_surge(4242)
    # Back to the title the way a player does it, then light the circle with the same seed.
    await game.press(Controls.pause)
    await game.click(PauseMenu, "main_menu")
    await game.advance_until(lambda: game.is_open(TitleScreen))
    assert await first_surge(4242) == first
    assert game.ctx.seed == 4242
    assert game.get(Records).last_seed == 4242


@playtest("enough XP opens a draft that freezes the fight, and a pick closes it")
async def level_up_draft(game: GameHarness):
    await start_run(game)
    survivor = game.world.placed(Placed.survivor)
    game.world.spawn(Prefabs.soul_mote, at=survivor.transform.position, components=[SoulMote(xp=8)])
    await game.advance_until(lambda: game.is_open(DraftPanel), timeout=2)
    assert game.get(Run).level == 2
    card = game.get(Draft).cards[0]
    await game.click(DraftPanel, "pick", upgrade=card.id)
    assert not game.is_open(DraftPanel)
    assert game.get(Draft).stacks[card] == 1


@playtest("the title has no pause key")
async def no_pause_on_title(game: GameHarness):
    await game.start(scene=Scenes.title)
    await game.press(Controls.pause)
    assert not game.is_open(PauseMenu)


@playtest("the bell and a killing blow in the same frame pay out once")
async def run_ends_once(game: GameHarness):
    await start_run(game)
    dust_before = game.get(Records).dust
    game.ctx.emit(RunEnded(survived=True))
    game.ctx.emit(RunEnded(survived=False))
    await game.advance(frames=1)
    assert game.get(Run).outcome is Outcome.SURVIVED
    assert game.get(Records).dust == dust_before + game.get(Run).dust_earned


@playtest("P pauses the arena and P resumes it")
async def pause_toggles(game: GameHarness):
    await start_run(game)
    await game.press(Controls.pause)
    assert game.is_open(PauseMenu)
    await game.press(Controls.pause)
    assert not game.is_open(PauseMenu)


@playtest("Second Wind rekindles once; the next fall ends the run and pays dust")
async def second_wind(game: GameHarness):
    await start_run(game)
    survivor = game.world.placed(Placed.survivor)
    survivor.get(Build).revives = 1
    survivor.get(Health).kill()
    await game.advance(frames=2)
    assert survivor.get(Health).fraction == 0.5
    assert not game.emitted(RunEnded)
    await game.advance(seconds=3)  # the rekindle's protection runs out
    dust_before = game.get(Records).dust
    survivor.get(Health).kill()
    await game.advance_until(lambda: game.is_open(RunOverPanel))
    assert game.get(Run).outcome is Outcome.FELL
    assert game.get(Records).dust > dust_before


@playtest("Shift dashes once, and the charge is back 1.6 s later")
async def dash_recharges(game: GameHarness):
    await start_run(game)
    survivor = game.world.placed(Placed.survivor)
    build = survivor.get(Build)
    await game.press(Controls.dash)
    assert build.dash_ready_at > game.ctx.time.now
    assert survivor.get(Health).invulnerable
    await game.advance(seconds=1.7)
    assert build.dash_ready_at <= game.ctx.time.now


@playtest("the bell ends the run survived with its payout card; Again lights a new circle")
async def circle_holds(game: GameHarness):
    await start_run(game)
    game.ctx.emit(RunEnded(survived=True))  # what RunClock emits at run_seconds
    await game.advance_until(lambda: game.is_open(RunOverPanel))
    assert game.get(Run).outcome is Outcome.SURVIVED
    await game.click(RunOverPanel, "again")
    await game.advance_until(lambda: game.world.query(Build).count() == 1)
    assert game.get(Run).outcome is None
    assert not game.is_open(RunOverPanel)


@playtest("a rekindle raises the HUD banner, and it clears on its own")
async def rekindle_banner(game: GameHarness):
    await start_run(game)
    survivor = game.world.placed(Placed.survivor)
    survivor.get(Build).revives = 1
    survivor.get(Health).kill()
    await game.advance(frames=2)
    assert game.panel_state(Hud)["alert"] == "THE EMBER REKINDLES"
    await game.advance(seconds=2.6)
    assert game.panel_state(Hud)["alert"] == ""
