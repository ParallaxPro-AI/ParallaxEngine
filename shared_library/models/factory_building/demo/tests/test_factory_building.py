from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("factory_building: the prefab spawns and its model's controls work")
async def test_factory_building(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.factory_building, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("roller_door_0", 2.475)
    assert abs(model.joint("roller_door_0") - 2.475) < 1e-3
    model.set_option("shutter_colour", "blue")
    assert model.option("shutter_colour") == "blue"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
