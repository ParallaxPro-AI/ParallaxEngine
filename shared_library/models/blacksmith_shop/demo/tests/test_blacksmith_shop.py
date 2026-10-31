from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("blacksmith_shop: the prefab spawns and its model's controls work")
async def test_blacksmith_shop(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.blacksmith_shop, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("side_door", 50.0)
    assert abs(model.joint("side_door") - 50.0) < 1e-3
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
