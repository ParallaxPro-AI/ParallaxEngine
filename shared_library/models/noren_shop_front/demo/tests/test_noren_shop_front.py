from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("noren_shop_front: the prefab spawns and its model's controls work")
async def test_noren_shop_front(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.noren_shop_front, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("door_l", 0.3)
    assert abs(model.joint("door_l") - 0.3) < 1e-3
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
