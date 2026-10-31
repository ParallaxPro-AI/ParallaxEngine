"""Headless playtests (fixed seed, fixed timestep)."""

from parallax import Model, vec2
from parallax.combat import Health
from parallax.test import GameHarness, playtest
from project import Content, Placed

from game.actions import BoutControls, Controls
from game.components import Bolt
from game.events import ExchangeResolved, LessonPassed, RoundEnded
from game.resources import Match, Mode, Phase
from game.ui import FightHud, PauseMenu, ResultScreen, TitleScreen


async def start(game: GameHarness, mode: Mode) -> None:
    await game.start()
    await game.click(TitleScreen, "start", mode=mode)
    await game.advance_until(lambda: game.get(Match).phase is Phase.FIGHT)


@playtest("a point-blank jab lands cleanly on the practice dummy")
async def jab_lands_on_dummy(game: GameHarness):
    await start(game, Mode.PRACTICE)
    # The corners start 5 m apart; walk until the pushboxes meet (0.8 s left a 2.26 m gap).
    await game.move(Controls.move, vec2(1, 0), seconds=1.4)
    await game.press(Controls.light)
    await game.advance(seconds=0.3)
    jabs = [hit for hit in game.emitted(ExchangeResolved) if hit.move == Content.move.jab]
    assert jabs and not jabs[0].blocked


@playtest("down, forward, Light throws a Chi Bolt")
async def quarter_circle_throws_bolt(game: GameHarness):
    await start(game, Mode.PRACTICE)
    await game.move(Controls.move, vec2(0, -1), seconds=0.05)
    await game.move(Controls.move, vec2(1, 0), seconds=0.05)
    await game.press(Controls.light)
    await game.advance(seconds=0.35)
    assert game.world.query(Bolt).count() == 1


@playtest("the first lesson passes by walking toward the rival")
async def first_lesson_passes(game: GameHarness):
    await start(game, Mode.TRAINING)
    await game.move(Controls.move, vec2(1, 0), seconds=0.6)
    assert [passed.lesson for passed in game.emitted(LessonPassed)] == [0]
    assert game.get(Match).lesson == 1


@playtest("nobody can be knocked out outside the circuit")
async def practice_is_non_lethal(game: GameHarness):
    await start(game, Mode.PRACTICE)
    dummy = game.world.placed(Placed.rival).get(Health)
    dummy.damage(dummy.max * 2)
    assert dummy.current == 1


@playtest("pause does nothing on the title screen")
async def no_pause_on_title(game: GameHarness):
    await game.start()
    await game.press(BoutControls.pause)
    assert game.is_open(TitleScreen) and not game.is_open(PauseMenu)


@playtest("pause opens the paused card and pause resumes")
async def pause_toggles(game: GameHarness):
    await start(game, Mode.CIRCUIT)
    await game.press(BoutControls.pause)
    assert game.is_open(PauseMenu)
    await game.press(BoutControls.pause)
    assert not game.is_open(PauseMenu)


@playtest("a circuit round always ends, by K.O. or on the clock")
async def round_ends(game: GameHarness):
    await start(game, Mode.CIRCUIT)
    await game.until(RoundEnded, timeout=70)


async def win_round(game: GameHarness) -> None:
    await game.advance_until(lambda: game.get(Match).phase is Phase.FIGHT, timeout=5)
    game.world.placed(Placed.rival).get(Health).kill()
    await game.until(RoundEnded, timeout=2)


@playtest("two K.O.s take the bout, and the next rival walks out in Ironjaw's amber kit")
async def bout_climbs_ladder(game: GameHarness):
    await start(game, Mode.CIRCUIT)
    assert game.world.placed(Placed.rival).get(Model).option("kit") == "indigo"
    await win_round(game)
    await win_round(game)
    await game.advance_until(lambda: game.get(Match).stage == 1, timeout=5)
    assert game.get(Match).round == 1
    assert game.world.placed(Placed.rival).get(Model).option("kit") == "amber"


@playtest("losing two rounds ends the run on the result screen; Retry restarts the bout")
async def loss_retry(game: GameHarness):
    await start(game, Mode.CIRCUIT)
    for _ in range(2):
        await game.advance_until(lambda: game.get(Match).phase is Phase.FIGHT, timeout=5)
        game.world.placed(Placed.challenger).get(Health).kill()
        await game.until(RoundEnded, timeout=2)
    await game.advance_until(lambda: game.is_open(ResultScreen), timeout=5)
    await game.click(ResultScreen, "retry")
    await game.advance_until(lambda: game.get(Match).phase is Phase.FIGHT, timeout=5)
    assert game.get(Match).stage == 0
    assert game.get(Match).rival_wins == 0


def percent(width: str) -> float:
    """A HUD bar width ("73.00%") as a number."""
    return float(width[:-1])


@playtest("a hit leaves a damage trail on the HUD that drains down to the health left")
async def damage_trail(game: GameHarness):
    await start(game, Mode.CIRCUIT)
    rival = game.world.placed(Placed.rival)
    rival.get(Health).damage(30)
    await game.advance(frames=2)
    rival = game.panel_state(FightHud)["rival"]
    assert percent(rival["trail"]) > percent(rival["health"])
    await game.advance(seconds=2)
    rival = game.panel_state(FightHud)["rival"]
    assert rival["trail"] == rival["health"]


@playtest("the intro banner names the rival, and the round-over banner says who took it")
async def round_banner(game: GameHarness):
    await game.start()
    await game.click(TitleScreen, "start", mode=Mode.CIRCUIT)
    await game.advance(frames=2)
    hud = game.panel_state(FightHud)
    assert hud["banner"] and hud["banner_big"] == "The Drifter" and hud["banner_role"].startswith("01")
    await win_round(game)
    hud = game.panel_state(FightHud)
    assert hud["banner"] and hud["banner_big"] == "ROUND WON" and hud["banner_won"]


@playtest("a super without 50 SPIRIT is refused with the warning call-out")
async def super_needs_spirit(game: GameHarness):
    await start(game, Mode.CIRCUIT)
    await game.press(Controls.super)
    await game.advance(frames=2)
    hud = game.panel_state(FightHud)
    assert hud["notice"] == "SUPER NEEDS 50 SPIRIT" and hud["notice_warn"]


@playtest("pausing shows the round, the clock and the rival on the card")
async def pause_card(game: GameHarness):
    await start(game, Mode.CIRCUIT)
    await game.press(BoutControls.pause)
    assert game.panel_state(PauseMenu)["where"].startswith("ROUND 1 · ")
    assert game.panel_state(PauseMenu)["where"].endswith("VS THE DRIFTER")
