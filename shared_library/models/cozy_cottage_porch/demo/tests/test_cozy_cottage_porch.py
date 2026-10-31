from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("cozy_cottage_porch: the prefab spawns and its model's controls work")
async def test_cozy_cottage_porch(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.cozy_cottage_porch, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("front_door", 47.5)
    assert abs(model.joint("front_door") - 47.5) < 1e-3
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
