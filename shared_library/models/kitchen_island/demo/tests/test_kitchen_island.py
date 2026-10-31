from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("kitchen_island: the prefab spawns and its model's controls work")
async def test_kitchen_island(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.kitchen_island, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("drawer_1", 0.248)
    assert abs(model.joint("drawer_1") - 0.248) < 1e-3
    model.set_option("cabinet_colour", "navy")
    assert model.option("cabinet_colour") == "navy"
    assert model.socket_position("counter_top").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
