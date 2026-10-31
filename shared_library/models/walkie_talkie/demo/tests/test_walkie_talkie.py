from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("walkie_talkie: the prefab spawns and its model's controls work")
async def test_walkie_talkie(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.walkie_talkie, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("ptt", 0.0015)
    assert abs(model.joint("ptt") - 0.0015) < 1e-3
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
