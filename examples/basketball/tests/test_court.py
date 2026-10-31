import math

from parallax import WorldBar, vec3
from parallax.characters import Character
from parallax.test import playtest
from project import Content, Placed, Scenes

from game.actions import Controls
from game.components import Away, Ball, BoxScore, Edge, Flight, Meter
from game.content import CourtRules
from game.events import BucketIncoming, BucketScored, ShotClockExpired, ShotReleased, Zone
from game.lib.barks import BarkSaid
from game.ladder import pick
from game.resources import Match, Phase, Result, Run
from game.rules import give_ball, you
from game.ui import GameOver, Hud, LockerRoom, TitleScreen


async def tip_off(game):
    """Close the title; the game clock opens the first quarter on its next tick."""
    await game.start(scene=Scenes.court, seed=3)
    await game.click(TitleScreen, "play")
    await game.advance_until(lambda: game.get(Match).phase is Phase.PLAYING, timeout=1)


def ball(game) -> Ball:
    _, possession = game.world.query(Ball).single()
    return possession


@playtest("you take the ball out at tip-off")
async def test_tip_off(game):
    await tip_off(game)
    assert game.get(Match).quarter == 1
    assert ball(game).holder == you(game.ctx)


@playtest("releasing near the top of the sweep is a green release")
async def test_green_release(game):
    await tip_off(game)
    shooter = you(game.ctx)
    shooter.get(Character).teleport(vec3(17, 0, 0))
    # Up-sweep takes half the 1.6 s charge: 0.67 s puts the needle at ~0.84.
    await game.hold(Controls.shoot, seconds=0.67)
    # hold() lets go after its last frame; the meter sees the release on the next one.
    await game.advance(frames=1)
    assert game.emitted(ShotReleased)[-1].zone is Zone.GREEN
    assert not shooter.get(WorldBar).shown
    await game.advance(seconds=1.6)
    assert shooter.get(BoxScore).attempts == 1


@playtest("a pass lands in your running mate's hands")
async def test_pass(game):
    await tip_off(game)
    await game.press(Controls.pass_ball)
    await game.advance(seconds=1)
    assert ball(game).holder == game.world.placed(Placed.mate)


@playtest("running out the shot clock hands the crew the ball")
async def test_shot_clock(game):
    await tip_off(game)
    ball(game).shot_clock = 0.05
    await game.advance(seconds=0.2)
    assert game.emitted(ShotClockExpired)
    assert ball(game).holder.has(Away)


@playtest("tied at the final buzzer goes to overtime")
async def test_overtime(game):
    await tip_off(game)
    match = game.get(Match)
    match.quarter = game.config(CourtRules).quarters
    match.clock = 0.05
    await game.advance(seconds=0.2)
    assert match.overtime == 1
    assert match.phase is Phase.PLAYING


@playtest("a win opens the locker room; a perk tips off the next game")
async def test_locker_room(game):
    await tip_off(game)
    match = game.get(Match)
    match.quarter, match.clock, match.home_score = game.config(CourtRules).quarters, 0.05, 2
    await game.advance(seconds=0.2)
    assert game.is_open(LockerRoom)
    card = game.get(Run).offers[0]
    await game.click(LockerRoom, "pick", card=card.id)
    assert not game.is_open(LockerRoom)
    assert game.get(Run).stage == 1
    assert game.get(Match).home_score == 0


@playtest("two Soft Touch cards widen the green window twice")
async def test_perks_stack(game):
    await tip_off(game)
    soft_touch = Content.perk.soft_touch
    meter = you(game.ctx).get(Meter)
    low, high = meter.green_low, meter.green_high
    pick(game.ctx, soft_touch)
    pick(game.ctx, soft_touch)
    assert math.isclose(meter.green_low, low + 2 * soft_touch.data.green_low)
    assert math.isclose(meter.green_high, high + 2 * soft_touch.data.green_high)


@playtest("one loss ends the run; Play again tips off a fresh run against the first crew")
async def test_loss_ends_run(game):
    await tip_off(game)
    match = game.get(Match)
    match.quarter, match.clock, match.away_score = game.config(CourtRules).quarters, 0.05, 2
    await game.advance(seconds=0.2)
    assert game.is_open(GameOver)
    assert game.get(Run).result is Result.ELIMINATED
    await game.click(GameOver, "play_again")
    await game.advance(frames=2)
    assert game.get(Run).stage == 0
    assert game.get(Run).result is Result.RUNNING


@playtest("your bucket gets a cheer from your running mate")
async def test_mate_cheers(game):
    await tip_off(game)
    shooter = you(game.ctx)
    game.ctx.emit(BucketScored(shooter=shooter, points=2, assist=None, contested=False))
    await game.advance(frames=2)
    said = game.emitted(BarkSaid)
    assert said and said[-1].speaker == game.world.placed(Placed.mate)
    assert said[-1].trigger == "cheer"


@playtest("the scoreboard shows game 1 of 5 and a live clock, and the possession plate who has the ball")
async def test_scoreboard_hud(game):
    await tip_off(game)
    hud = game.panel_state(Hud)
    assert (hud["stage"], hud["stages"], hud["phase"]) == (1, 5, "LIVE")
    _, ball = game.world.query(Ball).single()
    assert hud["possession_state"] in ("HOLD", "LOOSE", "FLIGHT")
    assert hud["no_shoot"] == (ball.holder != you(game.ctx))


@playtest("a contested make is a clutch bucket: the slow-mo bucket cam fires before it lands")
async def test_bucket_incoming(game):
    await tip_off(game)
    shooter = you(game.ctx)
    rival = game.world.query(tagged=Away).entities()[0]
    for _ in range(12):  # a contested green goes in ~43% of the time
        shooter.get(Character).teleport(vec3(19, 0, 0))
        rival.get(Character).teleport(vec3(19.8, 0, 0))
        give_ball(game.ctx, shooter)
        game.ctx.emit(ShotReleased(shooter=shooter, zone=Zone.GREEN))
        await game.advance(frames=1)
        _, flight = game.world.query(Flight).single()
        if flight.made:
            break
        await game.advance(seconds=2)
    assert flight.made
    assert game.emitted(BucketIncoming)[-1].shooter == shooter
