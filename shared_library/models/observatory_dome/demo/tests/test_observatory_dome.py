from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("observatory_dome: the prefab spawns and its model's controls work")
async def test_observatory_dome(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.observatory_dome, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("shutter", 50.0)
    assert abs(model.joint("shutter") - 50.0) < 1e-3
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
