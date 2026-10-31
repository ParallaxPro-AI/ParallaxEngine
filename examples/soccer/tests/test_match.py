import math

from parallax import Model, vec2, vec3
from parallax.characters import Character
from parallax.physics import Rigidbody
from parallax.test import playtest
from project import Content, Placed, Scenes

from game.actions import Controls
from game.components import Away, Ball, Footballer, Home
from game.events import GoalScored, PossessionWon
from game.resources import Cup, Match, Phase
from game.rules import goal_defended_by
from game.training import pick
from game.ui import FullTime, TeamTalk, TitleScreen


async def kick_off(game):
    await game.start(scene=Scenes.stadium, seed=7)
    await game.click(TitleScreen, "kick_off")
    await game.advance_until(lambda: game.get(Match).phase is Phase.PLAYING, timeout=5)


async def final_whistle(game, home: int, away: int):
    """Jump to the last moments of the second half at this score."""
    match = game.get(Match)
    match.home_goals, match.away_goals = home, away
    match.half, match.clock = 2, 0.01
    await game.advance(seconds=0.5)


@playtest("the countdown hands over to live play and the clock runs")
async def test_kickoff(game):
    await kick_off(game)
    clock = game.get(Match).clock
    await game.advance(seconds=2)
    assert game.get(Match).clock < clock


@playtest("a ball rolled into the away net is a home goal and play restarts")
async def test_goal(game):
    await kick_off(game)
    ball, _, body = game.world.query(Ball, Rigidbody).single()
    net = goal_defended_by(game.ctx, Away).transform.position
    # Past the keeper (who stands 4 m off his line at kickoff and clears anything within
    # 2.3 m of him), so the shot is not swept away before it reaches the net.
    body.teleport(net + vec3(-1.5, 0.3, 0))
    body.velocity = vec3(20, 0, 0)
    await game.advance_until(lambda: game.get(Match).home_goals == 1, timeout=2)
    assert game.emitted(GoalScored)[-1].team is Home
    await game.advance_until(lambda: game.get(Match).phase is Phase.PLAYING, timeout=8)
    assert ball.transform.position.distance_to(game.world.placed(Placed.centre_spot).transform.position) < 3


@playtest("you win the ball by running onto it, and can't lose it to a teammate")
async def test_possession(game):
    await kick_off(game)
    _, possession = game.world.query(Ball).single()
    await game.move(Controls.move, vec2(1, 0), seconds=1.5)
    assert possession.holder == game.get(Match).controlled
    assert all(event.previous is None for event in game.emitted(PossessionWon))


@playtest("switch hands control to another outfielder")
async def test_switch(game):
    await kick_off(game)
    before = game.get(Match).controlled
    await game.press(Controls.switch)
    assert game.get(Match).controlled != before


@playtest("losing the tie ends the run")
async def test_knocked_out(game):
    await kick_off(game)
    await final_whistle(game, home=0, away=1)
    assert game.is_open(FullTime)


@playtest("winning a tie opens the team talk; a pick starts the next round")
async def test_team_talk(game):
    await kick_off(game)
    await final_whistle(game, home=1, away=0)
    assert game.is_open(TeamTalk)
    card = game.get(Cup).offers[0]
    await game.click(TeamTalk, "pick", card=card.id)
    assert not game.is_open(TeamTalk)
    assert game.get(Cup).round == 1
    assert game.get(Cup).training == [card]


@playtest("a second pick of the same card stacks on top of the first")
async def test_training_stacks(game):
    await kick_off(game)
    captain = game.world.placed(Placed.captain)
    sprint, finishing = Content.training.sprint_coach, Content.training.finishing_school
    pace, power = captain.get(Character).walk_speed, captain.get(Footballer).kick_power
    for _ in range(2):
        pick(game.ctx, sprint)
    pick(game.ctx, finishing)
    assert math.isclose(captain.get(Character).walk_speed, pace + 2 * sprint.data.control_speed)
    assert math.isclose(captain.get(Footballer).kick_power, power + finishing.data.kick_power)


@playtest("every footballer wears one of the template's eight kit models")
async def test_kits(game):
    await game.start(scene=Scenes.stadium)
    players = [model for entity, model in game.world.query(Model) if entity.has(Footballer)]
    assert len(players) == 10
    kits = {model.model.path for model in players}
    assert len(kits) == 8
    assert all(path.startswith("https://r2.parallaxpro.ai/assets/model_character/") for path in kits)
