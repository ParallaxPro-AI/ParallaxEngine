from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("scifi_door_double: the prefab spawns and its model's controls work")
async def test_scifi_door_double(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.scifi_door_double, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("leaf_l", 0.475)
    assert abs(model.joint("leaf_l") - 0.475) < 1e-3
    model.set_option("light_colour", "amber")
    assert model.option("light_colour") == "amber"
    assert model.socket_position("socket_threshold").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
