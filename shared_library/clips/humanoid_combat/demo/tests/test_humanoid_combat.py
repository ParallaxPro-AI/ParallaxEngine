"""Every humanoid_combat clip loads (parallax check parses each file with the runtime's parser), plays on a
humanoid skeleton, finishes when played once, and fires its markers."""

from parallax import AnimationEvent, Animator, ClipFinished
from parallax.test import playtest
from project import Assets, Placed, Scenes

LOOPING = [Assets.clips.channel_cast, Assets.clips.recall_channel, Assets.clips.guard_stance, Assets.clips.downed_breathing]
ONE_SHOTS = [Assets.clips.overhead_swing, Assets.clips.cleave_swing, Assets.clips.thrust_lunge, Assets.clips.bow_shot, Assets.clips.cast_forward, Assets.clips.cast_overhead, Assets.clips.ground_slam, Assets.clips.evade_leap, Assets.clips.evade_recover, Assets.clips.get_up_back, Assets.clips.get_up_front]
MARKERS = [(Assets.clips.overhead_swing, "windup"), (Assets.clips.cleave_swing, "windup"), (Assets.clips.thrust_lunge, "windup"), (Assets.clips.bow_shot, "windup"), (Assets.clips.cast_forward, "windup"), (Assets.clips.cast_overhead, "windup"), (Assets.clips.ground_slam, "windup")]


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
