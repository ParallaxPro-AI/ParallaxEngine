from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("mic_stand: the prefab spawns and its model's controls work")
async def test_mic_stand(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.mic_stand, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("height", 0.175)
    assert abs(model.joint("height") - 0.175) < 1e-3
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
