from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("house_door_interior: the prefab spawns and its model's controls work")
async def test_house_door_interior(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.house_door_interior, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("door", 50.0)
    assert abs(model.joint("door") - 50.0) < 1e-3
    model.set_option("paint", "white")
    assert model.option("paint") == "white"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
