from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("trapdoor_floor: the prefab spawns and its model's controls work")
async def test_trapdoor_floor(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.trapdoor_floor, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("leaf", 55.0)
    assert abs(model.joint("leaf") - 55.0) < 1e-3
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
