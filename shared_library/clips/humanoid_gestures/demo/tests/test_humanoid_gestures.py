"""Every humanoid_gestures clip loads (parallax check parses each file with the runtime's parser),
plays on a humanoid skeleton, finishes when played once, and fires its markers."""

from parallax import AnimationEvent, Animator, ClipFinished
from parallax.test import playtest
from project import Assets, Placed, Scenes

LOOPING = [
    Assets.clips.wave_hello, Assets.clips.beckon, Assets.clips.point_forward, Assets.clips.hands_on_head,
    Assets.clips.explain, Assets.clips.plead, Assets.clips.present, Assets.clips.show_sheet, Assets.clips.write_on_pad,
    Assets.clips.mime_phone, Assets.clips.mime_drink, Assets.clips.mime_eat, Assets.clips.mime_camera,
    Assets.clips.mime_sleep, Assets.clips.mime_tap_wrist, Assets.clips.stomach_ache, Assets.clips.headache,
    Assets.clips.point_self, Assets.clips.sob, Assets.clips.look_around, Assets.clips.impatient,
    Assets.clips.scratch_head, Assets.clips.measure_height, Assets.clips.mime_steer, Assets.clips.shiver,
    Assets.clips.wring_hands, Assets.clips.stand_talk_idle,
]
ONE_SHOTS = [
    Assets.clips.shrug, Assets.clips.head_shake, Assets.clips.nod_yes, Assets.clips.facepalm, Assets.clips.frustrated,
    Assets.clips.rummage, Assets.clips.bow, Assets.clips.cheer, Assets.clips.arms_wide, Assets.clips.stop_palm,
    Assets.clips.thank_you,
]
MARKERS = [(Assets.clips.frustrated, "stomp"), (Assets.clips.rummage, "grab"), (Assets.clips.mime_camera, "click"),
           (Assets.clips.cheer, "hop"), (Assets.clips.impatient, "tap")]


async def puppet(game):
    await game.start(scene=Scenes.stage)
    return game.world.placed(Placed.puppet).get(Animator)


@playtest("every looping gesture plays on the puppet")
async def test_loops(game):
    animator = await puppet(game)
    for clip in LOOPING:
        animator.play(clip, fade=0)
        await game.advance(frames=3)
        assert animator.clip == clip, f"{clip.name} is not playing"


@playtest("every one-shot gesture plays to its end")
async def test_one_shots(game):
    animator = await puppet(game)
    for clip in ONE_SHOTS:
        animator.play_once(clip, fade=0)
        finished = await game.until(ClipFinished, timeout=6)
        assert finished.clip == clip, f"{finished.clip.name} finished instead of {clip.name}"


@playtest("gestures with markers fire them as they play")
async def test_markers(game):
    animator = await puppet(game)
    for clip, name in MARKERS:
        animator.play_once(clip, fade=0)
        marker = await game.until(AnimationEvent, timeout=6)
        assert marker.name == name and marker.clip == clip, f"{clip.name}: got {marker.name}"
        await game.until(ClipFinished, timeout=6)
