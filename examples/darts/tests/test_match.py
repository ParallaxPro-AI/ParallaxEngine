from parallax.test import GameHarness, playtest
from parallax.values import Vec2
from project import Content, Placed, Scenes

from game.actions import Controls
from game.components import Phase, Throw
from game.config import Board, House
from game.content import par_total
from game.darts import Hit, Ring, score_dart
from game.darts import Outcome
from game.events import DartScored, LegWon, MatchEnded
from game.resources import Air, Career, Match, Stage
from game.ui import GameOver, LegCard, TitleScreen

CLEAN_HOLD = 0.58  # seconds of charge: power ~0.55, inside the clean band
PREVIEW_HOLD = 0.65  # seconds of charge: power ~0.62, the power the aim line is drawn at


async def calm_and_aim_at_bull(h: GameHarness) -> None:
    """Still the air, then walk the aim up until the predicted landing (the aim
    line's last bead) sits on the bull — the drop the player reads off the line."""
    air = h.get(Air)
    air.speed = air.leg_speed = 0.0
    throw = h.world.placed(Placed.dart).get(Throw)
    board = h.world.placed(Placed.board).transform.position
    for _ in range(4):
        await h.advance(frames=1)
        landing = throw.path[-1]
        throw.aim = Vec2(throw.aim.x, throw.aim.y + (board.y - landing.y))


def throw_phase(h: GameHarness) -> Phase:
    return h.world.placed(Placed.dart).get(Throw).phase


@playtest("a leg starts on its number with a dart in hand")
async def test_leg_starts(h: GameHarness):
    await h.start(scene=Scenes.oche_hall)
    assert h.get(Match).remaining == Content.leg.opener.data.start
    assert throw_phase(h) is Phase.AIMING


@playtest("a clean throw lands, scores and comes back to the hand")
async def test_throw_scores(h: GameHarness):
    await h.start(scene=Scenes.oche_hall)
    await h.hold(Controls.throw, CLEAN_HOLD)
    await h.until(DartScored)
    match = h.get(Match)
    assert match.darts == 1
    assert match.remaining <= Content.leg.opener.data.start
    await h.advance_until(lambda: throw_phase(h) is Phase.AIMING)


@playtest("a dart thrown wide of the board is a penalty")
async def test_miss_penalty(h: GameHarness):
    await h.start(scene=Scenes.oche_hall)
    await h.move(Controls.aim, Vec2(1, 1), seconds=3)
    await h.hold(Controls.throw, CLEAN_HOLD)
    scored = await h.until(DartScored)
    assert scored.outcome is Outcome.MISS
    assert scored.penalty == Content.penalty.miss
    assert h.get(Match).remaining == Content.leg.opener.data.start


@playtest("a locked tier can't be picked on the title card")
async def test_locked_tier(h: GameHarness):
    await h.start(scene=Scenes.title)
    await h.click(TitleScreen, "tier", step=1)
    assert h.get(Career).tier == 0


@playtest("stepping to the oche seeds the night's air from the matches played")
async def test_match_seed(h: GameHarness):
    await h.start(scene=Scenes.title)
    await h.click(TitleScreen, "start")
    await h.advance_until(lambda: h.ctx.scenes.current_is(Scenes.oche_hall))
    assert h.ctx.seed == h.ctx.config(House).draught_seed + h.get(Career).matches


@playtest("the shipped board scores the bull and treble twenty")
async def test_shipped_board(h: GameHarness):
    await h.start(scene=Scenes.title)
    board = h.ctx.config(Board)
    treble = board.radius * (board.treble_inner + board.treble_outer) / 2
    assert score_dart(Vec2(0, 0), board).ring is Ring.INNER_BULL
    assert score_dart(Vec2(0, treble), board) == Hit(ring=Ring.TREBLE, number=20, value=60)


@playtest("A/D walk the reticle to the thrower's own left and right")
async def test_aim_follows_the_thrower(h: GameHarness):
    await h.start(scene=Scenes.oche_hall)
    await h.move(Controls.aim, Vec2(1, 0), seconds=0.5)
    throw = h.world.placed(Placed.dart).get(Throw)
    assert throw.aim.x > 0.2
    # The thrower looks down -z, so their right is world -x: the predicted
    # landing drifts that way too.
    board = h.world.placed(Placed.board).transform.position
    assert throw.path[-1].x < board.x - 0.1


@playtest("a dart on the bull checks out 50, the leg card follows, and the next leg starts")
async def test_checkout_and_next_leg(h: GameHarness):
    await h.start(scene=Scenes.oche_hall)
    h.get(Match).remaining = 50
    await calm_and_aim_at_bull(h)
    await h.hold(Controls.throw, PREVIEW_HOLD)
    scored = await h.until(DartScored)
    assert scored.hit.ring is Ring.INNER_BULL
    assert scored.outcome is Outcome.CHECKOUT
    match = h.get(Match)
    assert match.stage is Stage.LEG_WON
    assert match.card[0].darts == 1
    await h.advance_until(lambda: h.is_open(LegCard))
    await h.click(LegCard, "next")
    assert match.leg == 1
    assert match.remaining == Content.leg.the_ton.data.start
    assert not h.is_open(LegCard)


@playtest("blowing the dart budget misses the cut, and Play again starts a fresh match")
async def test_missed_cut_and_restart(h: GameHarness):
    await h.start(scene=Scenes.oche_hall)
    match = h.get(Match)
    budget = par_total(h.ctx) + match.tier.data.budget_over_par
    match.total_darts = budget
    await h.move(Controls.aim, Vec2(1, 1), seconds=3)
    await h.hold(Controls.throw, CLEAN_HOLD)
    ended = await h.until(MatchEnded)
    assert not ended.won
    await h.advance_until(lambda: h.is_open(GameOver))
    played = h.get(Career).matches
    assert played == 1
    await h.click(GameOver, "play_again")
    await h.advance_until(lambda: h.get(Match).stage is Stage.THROWING and h.get(Match).total_darts == 0)
    assert h.get(Match).remaining == Content.leg.opener.data.start
