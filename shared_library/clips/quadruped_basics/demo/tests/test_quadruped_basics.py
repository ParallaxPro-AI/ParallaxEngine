"""Every quadruped_basics clip loads (parallax check parses each file with the runtime's parser), plays on a
quadruped skeleton, finishes when played once, and fires its markers."""

from parallax import AnimationEvent, Animator, ClipFinished
from parallax.test import playtest
from project import Assets, Placed, Scenes

LOOPING = [Assets.clips.quadruped_idle, Assets.clips.quadruped_walk, Assets.clips.quadruped_trot]
ONE_SHOTS = [Assets.clips.quadruped_sit, Assets.clips.quadruped_loaf, Assets.clips.quadruped_pounce, Assets.clips.quadruped_paw, Assets.clips.quadruped_eat, Assets.clips.quadruped_meow]
MARKERS = [(Assets.clips.quadruped_pounce, "launch"), (Assets.clips.quadruped_paw, "paw_contact"), (Assets.clips.quadruped_eat, "munch"), (Assets.clips.quadruped_meow, "vocalize")]


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


@playtest("every one-shot clip plays to its end")
async def test_one_shots(game):
    animator = await puppet(game)
    for clip in ONE_SHOTS:
        animator.play_once(clip, fade=0)
        finished = await game.until(ClipFinished, timeout=6)
        assert finished.clip == clip, f"{finished.clip.name} finished instead of {clip.name}"


@playtest("clips with markers fire them as they play")
async def test_markers(game):
    animator = await puppet(game)
    for clip, name in MARKERS:
        animator.play_once(clip, fade=0)
        marker = await game.until(AnimationEvent, timeout=6)
        assert marker.name == name and marker.clip == clip, f"{clip.name}: got {marker.name}"
        await game.until(ClipFinished, timeout=6)
