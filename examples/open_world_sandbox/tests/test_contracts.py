"""Mara's first run, start to finish: the quiet way, and the fast pickup that brings the police."""

from parallax import EntityRef, vec3
from parallax.characters import Character
from parallax.physics import Rigidbody
from parallax.story import DialogueEnded, QuestCompleted, QuestStepCompleted
from parallax.test import GameHarness, playtest
from project import Content, Placed, Scenes

from features.missions.feature import BoardControls, ContractsPanel, JobControls, JobRules
from features.on_foot.feature import OnFootControls, Wallet
from features.police.feature import Wanted, wanted_level


async def drive_to(game: GameHarness, bay: EntityRef) -> None:
    """Park the player's car in a bay (teleport; driving itself is tested elsewhere) and let it settle."""
    car = game.world.placed(Placed.player).get(Character).vehicle
    car.get(Rigidbody).teleport(game.world.placement(bay).position)
    await game.advance(seconds=1)


async def skip_dialogue(game: GameHarness) -> None:
    ended = len(game.emitted(DialogueEnded))
    while len(game.emitted(DialogueEnded)) == ended:
        await game.press(OnFootControls.enter)
        await game.advance(seconds=0.3)


async def take_first_run(game: GameHarness) -> None:
    """Accept Mara's first run from the board and get behind the wheel of her car."""
    await game.press(BoardControls.contracts)
    await game.click(ContractsPanel, "accept", contract="first_run")
    await skip_dialogue(game)
    player = game.world.placed(Placed.player)
    player.transform.position = game.world.placed(Placed.maras_car).transform.position + vec3(2, 0, 0)
    await game.advance(frames=2)
    await game.press(OnFootControls.enter)
    await game.advance(frames=2)


def steps_done(game: GameHarness) -> list[str]:
    return [e.step for e in game.emitted(QuestStepCompleted) if e.quest == Content.quest.first_run]


@playtest("a quiet first run skips the escape, pays the bonus and unlocks the next jobs")
async def test_first_run_quiet(game: GameHarness):
    await game.start(scene=Scenes.sunset_bay, seed=5)
    cash = game.get(Wallet).cash
    await take_first_run(game)
    assert steps_done(game) == ["car"]

    await drive_to(game, Placed.supply_bay)
    await game.press(JobControls.handover)
    await game.advance(seconds=game.config(JobRules).quiet_load + 0.5)
    assert steps_done(game) == ["car", "pickup", "load"]
    assert game.ctx.story.quest(Content.quest.first_run).active_steps == ["deliver"]

    await drive_to(game, Placed.safehouse_bay)
    await game.press(JobControls.handover)
    await game.advance(frames=2)
    first_run = Content.quest.first_run.data
    assert game.get(Wallet).cash == cash + first_run.reward + first_run.quiet_bonus
    assert Content.quest.first_run in [e.quest for e in game.emitted(QuestCompleted)]

    await skip_dialogue(game)
    await game.press(BoardControls.contracts)
    board = {row["contract"]: row["status"] for row in game.panel_state(ContractsPanel)["contracts"]}
    assert board == {"first_run": "done", "wrong_plates": "available", "closing_window": "available"}


@playtest("a fast pickup loads quicker but draws heat, and the run branches to losing it")
async def test_first_run_rushed(game: GameHarness):
    await game.start(scene=Scenes.sunset_bay, seed=5)
    await take_first_run(game)
    await drive_to(game, Placed.supply_bay)
    await game.press(JobControls.fast_pickup)
    await game.advance(seconds=game.config(JobRules).risky_load + 0.5)
    assert wanted_level(game.get(Wanted)) >= 1
    assert steps_done(game) == ["car", "pickup", "load"]
    assert game.ctx.story.quest(Content.quest.first_run).active_steps == ["escape"]
