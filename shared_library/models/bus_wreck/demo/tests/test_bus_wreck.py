from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("bus_wreck: the prefab spawns and its model's controls work")
async def test_bus_wreck(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.bus_wreck, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("door_front", 44.0)
    assert abs(model.joint("door_front") - 44.0) < 1e-3
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
