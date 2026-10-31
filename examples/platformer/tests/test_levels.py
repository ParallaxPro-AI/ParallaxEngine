"""Playtests for the hub and a level."""

from parallax import vec2, vec3
from parallax.characters import Character
from parallax.test import GameHarness, playtest
from project import Content, Placed, Scenes

from game.actions import Controls
from game.components import Collectible, CrystalPlate, Goal, Player
from game.config import Rules
from game.events import DeathCause, PlayerDied, Respawned
from game.resources import Attempt, Mode, Profile
from game.ui import LevelSelect, PauseMenu, Results, TitleScreen


@playtest("the title opens the level list and a level loads")
async def test_choose_level(game: GameHarness):
    await game.start(scene=Scenes.hub)
    await game.click(TitleScreen, "start")
    await game.advance(frames=1)
    assert game.is_open(LevelSelect)
    await game.click(LevelSelect, "play", level=Content.level.sunny_meadow)
    await game.advance(frames=2)
    assert game.ctx.scenes.current_is(Scenes.level_sunny_meadow)
    attempt = game.get(Attempt)
    assert attempt.level == Content.level.sunny_meadow
    assert attempt.keepsakes_total == 3


@playtest("the pause key works in a level (by scene tag) but not in the hub")
async def test_pause_only_in_levels(game: GameHarness):
    await game.start(scene=Scenes.hub)
    await game.press(Controls.pause)
    assert not game.is_open(PauseMenu)
    await game.click(TitleScreen, "start")
    await game.advance(frames=1)
    await game.click(LevelSelect, "play", level=Content.level.emberfall)
    await game.advance(frames=2)
    await game.press(Controls.pause)
    assert game.is_open(PauseMenu)


@playtest("leaving a level lands on the level list, not the title")
async def test_exit_to_level_select(game: GameHarness):
    await game.start(scene=Scenes.level_sunny_meadow)
    await game.press(Controls.pause)
    await game.click(PauseMenu, "quit")
    await game.advance(frames=2)
    assert game.ctx.scenes.current_is(Scenes.hub)
    assert game.is_open(LevelSelect)
    assert game.get(Attempt).level is None


@playtest("falling off the world respawns you; explore mode keeps your lives")
async def test_fall_and_respawn(game: GameHarness):
    await game.start(scene=Scenes.level_sunny_meadow)
    rules = game.config(Rules)
    player = game.world.query(tagged=Player).single()
    player.transform.position = player.transform.position.with_y(rules.kill_plane - 1)
    await game.advance(frames=2)
    assert game.emitted(PlayerDied)[0].cause is DeathCause.FELL
    await game.advance(seconds=rules.death_pause + 0.1)
    assert len(game.emitted(Respawned)) == 1
    assert game.get(Attempt).lives == rules.start_lives
    assert player.transform.position.y > rules.kill_plane


@playtest("challenge mode: the last life fails the level")
async def test_challenge_fail(game: GameHarness):
    await game.start(scene=Scenes.level_sunny_meadow)
    rules = game.config(Rules)
    game.get(Profile).mode = Mode.CHALLENGE
    player = game.world.query(tagged=Player).single()
    for _ in range(rules.start_lives):
        player.transform.position = player.transform.position.with_y(rules.kill_plane - 1)
        await game.advance(seconds=rules.death_pause + rules.respawn_grace + 0.1)
    assert game.is_open(Results)
    assert not game.get(Attempt).won


@playtest("side-scroller: run right, jump the gap to the next island and collect its coins")
async def test_run_and_jump(game: GameHarness):
    await game.start(scene=Scenes.level_sunny_meadow)
    player = game.world.query(tagged=Player).single()
    # The first island ends 4 m right of the spawn and the next starts 2 m later: take off
    # before the edge and keep holding right through the air to the coin row.
    await game.set_axis(Controls.run, 1, seconds=0.3)
    await game.press(Controls.jump)
    await game.set_axis(Controls.run, 1, seconds=0.2)
    assert not player.get(Character).grounded
    await game.set_axis(Controls.run, 1, seconds=0.5)
    await game.advance_until(lambda: game.get(Attempt).coins > 0, timeout=3)
    await game.advance_until(lambda: player.get(Character).grounded, timeout=2)
    assert 6 < player.transform.position.x < 14  # on the second island
    assert player.transform.position.y > 1.9
    assert player.transform.position.z == 0  # still on the lane


@playtest("the hero stays on the lane: a sideways shove and a stick pushed into depth don't move it in z")
async def test_lane_lock(game: GameHarness):
    await game.start(scene=Scenes.level_sunny_meadow)
    player = game.world.query(tagged=Player).single()
    await game.advance(seconds=0.3)
    player.get(Character).knockback(vec3(0, 0, 12))
    await game.advance(seconds=0.5)
    player.get(Character).move(vec3(0.5, 0, 1))
    await game.advance(seconds=0.3)
    assert player.transform.position.z == 0
    assert player.get(Character).grounded


@playtest("a keepsake ledge is reachable: double jump onto the crumble step, then hop up to the isle")
async def test_keepsake_ledge(game: GameHarness):
    await game.start(scene=Scenes.level_sunny_meadow)
    player = await teleport(game, vec3(33, 4.2, 0))
    await game.advance(seconds=0.3)
    await game.hold(Controls.jump, seconds=0.05)
    await game.set_axis(Controls.run, -0.4, seconds=0.25)
    await game.press(Controls.jump)
    await game.set_axis(Controls.run, -0.4, seconds=0.45)
    await game.advance_until(lambda: player.get(Character).grounded, timeout=2)
    assert player.transform.position.y > 6.2  # on the crumble step
    await game.press(Controls.jump)
    await game.set_axis(Controls.run, -1, seconds=0.6)
    await game.advance_until(lambda: game.get(Attempt).keepsakes > 0, timeout=2)


async def teleport(game: GameHarness, at):
    player = game.world.query(tagged=Player).single()
    player.transform.position = at
    await game.advance(frames=3)
    return player


@playtest("the sky gate: all keepsakes, under par, no falls is three stars; Next Level loads the next world")
async def test_gate_stars_next_level(game: GameHarness):
    await game.start(scene=Scenes.level_sunny_meadow)
    rules = game.config(Rules)
    keepsakes = [
        entity.transform.position
        for entity, item in game.world.query(Collectible)
        if item.kind == Content.collectible.keepsake
    ]
    assert len(keepsakes) == 3
    for at in keepsakes:
        await teleport(game, at)
    attempt = game.get(Attempt)
    assert attempt.keepsakes == 3
    gate = game.world.query(tagged=Goal).single()
    await teleport(game, gate.transform.position)
    assert attempt.ended and attempt.won
    assert game.is_open(Results)
    assert attempt.stars == 3
    assert attempt.score >= rules.goal_bonus + attempt.lives * rules.lives_bonus
    await game.click(Results, "next")
    await game.advance(frames=2)
    assert game.ctx.scenes.current_is(Scenes.level_crystal_caverns)
    assert game.get(Attempt).level == Content.level.crystal_caverns


@playtest("Lantern Hollows: both crystal plates raise the bridge to the vault and its heart")
async def test_vault_plates(game: GameHarness):
    await game.start(scene=Scenes.level_crystal_caverns)
    rules = game.config(Rules)
    plate_a = game.world.placed(Placed.plate_a)
    plate_b = game.world.placed(Placed.plate_b)
    bridge = game.world.placed(Placed.crystal_bridge)
    hidden_y = bridge.transform.position.y
    assert not bridge.visible
    assert not plate_a.child("glow").visible
    await teleport(game, plate_a.transform.position + vec3(0, 0.1, 0))
    assert plate_a.get(CrystalPlate).lit and plate_a.child("glow").visible
    assert not plate_b.get(CrystalPlate).lit and not bridge.visible
    await teleport(game, plate_b.transform.position + vec3(0, 0.1, 0))
    assert bridge.visible
    await game.advance(seconds=rules.vault_bridge_rise / rules.vault_bridge_speed + 0.2)
    assert abs(bridge.transform.position.y - (hidden_y + rules.vault_bridge_rise)) < 0.05
    # The risen bridge is solid: standing on it holds you up level with the vault.
    player = await teleport(game, bridge.transform.position + vec3(0, 1, 0))
    await game.advance(seconds=1)
    assert player.transform.position.y > bridge.transform.position.y
    heart = next(
        entity for entity, item in game.world.query(Collectible) if item.kind == Content.collectible.heart
    )
    await teleport(game, heart.transform.position)
    assert game.get(Attempt).lives == rules.start_lives + 1
