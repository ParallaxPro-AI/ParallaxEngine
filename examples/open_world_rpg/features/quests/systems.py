"""Talking, the chapter chain, and the Shadow Rift's countdown."""

from parallax import ContentRef, Context, SceneLoaded, System, on, system
from parallax.combat import Died
from parallax.story import QuestCompleted, QuestStarted
from project import Text

from parallax.hud import Nameplate

from features.combat.feature import Spellbook
from features.hero.feature import Checkpoint, Hero, XpGained
from features.inventory.feature import Purse, give
from features.quests.actions import QuestControls
from features.quests.components import Npc, Talkable
from features.quests.config import ShadowRift
from features.quests.content import Chapter
from features.quests.resources import Doom, Ending, Focus, Outcome
from features.quests.rift import rift_running
from game.audio import Sounds, play
from game.feed import Kind, announce


@system("interaction")
class Interaction(System):
    """Keeps track of the NPC within reach and starts their conversation on Interact."""

    def update(self, ctx, dt):
        focus = ctx.get(Focus)
        here = ctx.world.query(tagged=Hero).single().transform.position
        row = ctx.world.query(Talkable, Nameplate, tagged=Npc).near(here, 8).nearest(here)
        in_reach = row is not None and row[0].transform.position.distance_to(here) <= row[1].reach
        focus.npc = row[0] if in_reach else None
        if focus.npc is not None and ctx.input.pressed(QuestControls.interact):
            talk = focus.npc.get(Talkable)
            ctx.story.say(talk.dialogue, node=talk.node, speaker=focus.npc)


@system("chapters")
class Chapters(System):
    """Walks the main story: opens the first chapter on a new game, pays each chapter out when it
    completes, and opens the next. Layers and objective markers follow the quests by themselves."""

    @on(SceneLoaded)
    def begin(self, ctx, event: SceneLoaded):
        play(ctx, ctx.config(Sounds).area_enter)
        first = ctx.content(Chapter)[0]
        if ctx.story.quest(first).status == "inactive":
            ctx.weather.set("clear", seconds=0)
            self.open(ctx, first)

    @on(QuestCompleted)
    def finish(self, ctx, event: QuestCompleted):
        chapters = ctx.content(Chapter)
        done = chapters.get(event.quest.id)
        self.reward(ctx, done.data)
        following = chapters.next(done)
        if following is None:
            end_story(ctx, Ending.VICTORY)
            return
        self.open(ctx, following)
        ctx.save.save("auto")

    def open(self, ctx, chapter: ContentRef[Chapter]):
        if chapter.data.checkpoint is not None:
            ctx.get(Checkpoint).shrine = chapter.data.checkpoint
        ctx.story.start_quest(chapter)

    def reward(self, ctx, chapter: Chapter):
        ctx.get(Purse).gold += chapter.reward_gold
        for item in chapter.reward_items:
            give(ctx, item)
        if chapter.reward_xp:
            ctx.emit(XpGained(amount=chapter.reward_xp))
        if chapter.teaches is not None:
            _, spellbook = ctx.world.query(Spellbook, tagged=Hero).single()
            spellbook.known.append(chapter.teaches)
            announce(ctx, ctx.text(Text.ability_learned, ability=ctx.text(chapter.teaches.data.name)))
        rewards = ctx.text(Text.chapter_rewards, xp=chapter.reward_xp, gold=chapter.reward_gold)
        announce(ctx, ctx.text(chapter.title), Kind.QUEST, rewards)
        play(ctx, ctx.config(Sounds).quest_complete)


@system("deadline", when=rift_running)
class Deadline(System):
    """The Shadow Rift. The chapter that opens it starts the clock and greys the sky (re-sent over the last minute, as the template does); while the run
    is undecided, each fall of the hero feeds it, and reaching zero
    ends the run in defeat. Pausing freezes it."""

    @on(QuestStarted, always=True)
    def open_rift(self, ctx, event: QuestStarted):
        if not ctx.content(Chapter).get(event.quest.id).data.opens_rift:
            return
        rift = ctx.config(ShadowRift)
        ctx.get(Doom).clock.restart(rift.duration)
        ctx.weather.set(rift.weather, seconds=rift.weather_blend)
        ctx.camera.main.shake(0.35, 0.9)

    @on(Died, where=lambda event: event.entity.has(Hero))
    def feed(self, ctx, event: Died):
        if ctx.get(Doom).clock.tick(ctx.config(ShadowRift).death_penalty):
            end_story(ctx, Ending.DEFEAT)

    def update(self, ctx, dt):
        doom = ctx.get(Doom)
        expired = doom.clock.tick(dt)
        if not doom.stormed and doom.clock.remaining <= ctx.config(ShadowRift).storm_at:
            doom.stormed = True
            ctx.weather.set(ctx.config(ShadowRift).storm, seconds=4)
        if expired:
            end_story(ctx, Ending.DEFEAT)


def end_story(ctx: Context, ending: Ending) -> None:
    """Decide the run: the end card follows `Outcome`, and the ending's cue plays."""
    ctx.get(Outcome).ending = ending
    sounds = ctx.config(Sounds)
    play(ctx, sounds.victory if ending is Ending.VICTORY else sounds.defeat)
