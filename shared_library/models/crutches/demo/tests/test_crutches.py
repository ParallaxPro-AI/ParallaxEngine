from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("crutches: the prefab spawns and its model's controls work")
async def test_crutches(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.crutches, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("crutch_l_frame", 0.06)
    assert abs(model.joint("crutch_l_frame") - 0.06) < 1e-3
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
