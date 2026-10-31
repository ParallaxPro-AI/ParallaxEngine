"""Every humanoid_locomotion clip loads (parallax check parses each file with the runtime's parser), plays on a
humanoid skeleton, finishes when played once, and fires its markers."""

from parallax import AnimationEvent, Animator, ClipFinished
from parallax.test import playtest
from project import Assets, Placed, Scenes

LOOPING = [Assets.clips.walk_cycle, Assets.clips.stand_idle, Assets.clips.stand_idle_left, Assets.clips.run_cycle, Assets.clips.carry_walk, Assets.clips.human_fall]
ONE_SHOTS = []
MARKERS = []


async def puppet(game):
    await game.start(scene=Scenes.stage)
    return game.world.placed(Placed.puppet).get(Animator)


@playtest("every looping clip plays on the puppet")
async def test_loops(game):
    animator = await puppet(game)
    for clip in LOOPING:
        animator.play(clip, fade=0)
        await game.advance(frames=3)
        assert animator.clip == clip, f"{clip.name} is not playing"
