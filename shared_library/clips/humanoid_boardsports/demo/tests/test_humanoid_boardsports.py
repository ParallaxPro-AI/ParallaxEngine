"""Every humanoid_boardsports clip loads (parallax check parses each file with the runtime's parser), plays on a
humanoid skeleton, finishes when played once, and fires its markers."""

from parallax import AnimationEvent, Animator, ClipFinished
from parallax.test import playtest
from project import Assets, Placed, Scenes

LOOPING = [Assets.clips.board_ride, Assets.clips.board_carve_toe, Assets.clips.board_carve_heel, Assets.clips.board_air]


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


@playtest("the grab plays to its end and fires grab, then release")
async def test_grab(game):
    animator = await puppet(game)
    animator.play_once(Assets.clips.board_grab, fade=0)
    grab = await game.until(AnimationEvent, timeout=4)
    assert grab.name == "grab" and grab.clip == Assets.clips.board_grab, f"got {grab.name}"
    release = await game.until(AnimationEvent, timeout=4)
    assert release.name == "release", f"got {release.name}"
    finished = await game.until(ClipFinished, timeout=4)
    assert finished.clip == Assets.clips.board_grab
