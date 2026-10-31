from parallax import vec3
from parallax.physics import Rigidbody
from parallax.test import playtest
from project import Content, Scenes

from game.actions import Controls
from game.components import Ball, Paddle, Smash
from game.events import BallReturned, WallHit
from game.resources import Best, Duel, Mods, Run
from game.ui import DraftPanel, GameOverPanel, PauseMenu, TitleScreen


async def shoot_at_goal(game, side: int):
    """Put the ball behind a paddle, heading into that goal (-1 player's, +1 rival's)."""
    await game.advance(seconds=1.5)
    ball = game.world.query(tagged=Ball).single()
    body = ball.get(Rigidbody)
    body.teleport(vec3(side * 10.5, 0.77, 0))
    body.velocity = vec3(side * 10, 0, 0)
    await game.advance(seconds=0.5)


@playtest("Serve on the title screen starts duel 1 against the first rival")
async def test_title_to_arena(game):
    await game.start(scene=Scenes.title)
    assert game.is_open(TitleScreen)
    await game.click(TitleScreen, "start")
    await game.advance(frames=2)
    assert game.ctx.scenes.current_is(Scenes.arena)
    assert game.get(Run).rival_index == 0 and game.get(Duel).serving


@playtest("the ball bounces off the side walls of the court")
async def test_wall_bounce(game):
    await game.start(scene=Scenes.arena, seed=7)
    await game.advance(seconds=1.5)
    body = game.world.query(tagged=Ball).single().get(Rigidbody)
    body.teleport(vec3(0, 0.77, 5.5))
    body.velocity = vec3(1, 0, 8)
    await game.until(WallHit, timeout=2)
    await game.advance(frames=2)
    assert body.velocity.z < 0


@playtest("the player's paddle returns the ball faster than it came")
async def test_player_return(game):
    await game.start(scene=Scenes.arena, seed=8)
    await game.advance(seconds=1.5)
    paddle = game.world.query(Smash).single()[0]
    body = game.world.query(tagged=Ball).single().get(Rigidbody)
    body.teleport(vec3(-6, 0.77, paddle.transform.position.z))
    body.velocity = vec3(-9, 0, 0)
    returned = await game.until(BallReturned, timeout=2)
    assert returned.source == paddle and not returned.smashed
    await game.advance(frames=1)
    assert body.velocity.x > 9
    assert game.get(Run).rally == 1


@playtest("the ball serves itself after the delay")
async def test_serve(game):
    await game.start(scene=Scenes.arena, seed=1)
    assert game.get(Duel).serving
    await game.advance(seconds=1.5)
    assert not game.get(Duel).serving


@playtest("holding smash during a rally builds a charge")
async def test_charge(game):
    await game.start(scene=Scenes.arena, seed=2)
    await game.advance(seconds=1.5)
    await game.hold(Controls.smash, seconds=0.35)
    _, smash = game.world.query(Smash).single()
    assert smash.charge >= smash.threshold


@playtest("Second Wind refunds the rival's first point")
async def test_second_wind(game):
    await game.start(scene=Scenes.arena, seed=3)
    game.get(Mods).shields = 1
    await shoot_at_goal(game, -1)
    duel = game.get(Duel)
    assert duel.rival_points == 0
    assert duel.shields_used == 1


@playtest("winning a duel drafts a perk and brings on the next rival")
async def test_duel_won(game):
    await game.start(scene=Scenes.arena, seed=4)
    game.get(Duel).player_points = 4
    await shoot_at_goal(game, 1)
    assert game.is_open(DraftPanel)
    assert game.panel_state(DraftPanel)["next_rival"] == "Drill Unit"

    await game.click(DraftPanel, "pick", perk=Content.perk.blade.id)
    await game.advance(frames=2)
    assert not game.is_open(DraftPanel)
    assert game.get(Run).rival_index == 1
    assert game.get(Mods).paddle_length == 1.35
    assert game.get(Duel).player_points == 0


@playtest("losing a duel ends the run; retry starts over and keeps the best score")
async def test_duel_lost(game):
    await game.start(scene=Scenes.arena, seed=5)
    game.get(Run).score = 250
    game.get(Duel).rival_points = 4
    await shoot_at_goal(game, -1)
    assert game.is_open(GameOverPanel)
    assert not game.get(Run).won
    assert game.get(Best).score == 250

    await game.click(GameOverPanel, "retry")
    await game.advance(frames=2)
    assert not game.is_open(GameOverPanel)
    assert game.get(Run).score == 0 and game.get(Duel).rival_points == 0
    assert game.get(Best).score == 250


@playtest("the pause key toggles the pause menu")
async def test_pause(game):
    await game.start(scene=Scenes.arena, seed=6)
    await game.press(Controls.pause)
    assert game.is_open(PauseMenu)
    await game.press(Controls.pause)
    assert not game.is_open(PauseMenu)


@playtest("there is no pause menu on the title screen")
async def test_no_pause_on_title(game):
    await game.start(scene=Scenes.title)
    await game.press(Controls.pause)
    assert not game.is_open(PauseMenu)


@playtest("Quit Run on the pause menu goes back to the title screen")
async def test_quit_to_title(game):
    await game.start(scene=Scenes.arena, seed=9)
    await game.press(Controls.pause)
    await game.click(PauseMenu, "quit")
    await game.advance(frames=2)
    assert game.ctx.scenes.current_is(Scenes.title)
    assert game.is_open(TitleScreen) and not game.is_open(PauseMenu)
