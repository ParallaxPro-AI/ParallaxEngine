"""Shared playtest steps."""

from parallax import ContentRef, EntityRef, vec3
from parallax.story import DialogueEnded
from parallax.test import GameHarness
from project import Placed

from features.quests.feature import Chapter, QuestControls


async def talk_to(game: GameHarness, npc_ref: EntityRef) -> None:
    """Walk up to an NPC and click through their whole conversation, through real inputs."""
    hero = game.world.placed(Placed.hero)
    hero.transform.position = game.world.placed(npc_ref).transform.position + vec3(0, 0, 2)
    await game.advance(frames=2)
    conversations = len(game.emitted(DialogueEnded))
    await game.press(QuestControls.interact)
    while len(game.emitted(DialogueEnded)) == conversations:
        await game.press(QuestControls.interact)
        await game.advance(seconds=0.3)


async def open_chapter(game: GameHarness, chapter: ContentRef[Chapter]) -> None:
    """Start a chapter directly, so its layer wakes without playing the chapters before it."""
    game.ctx.story.start_quest(chapter)
    await game.advance(frames=2)
