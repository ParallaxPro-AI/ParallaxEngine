from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("refuse_truck: the prefab spawns and its model's controls work")
async def test_refuse_truck(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.refuse_truck, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("lifter", 59.0)
    assert abs(model.joint("lifter") - 59.0) < 1e-3
    model.set_option("body", "flatbed")
    assert model.option("body") == "flatbed"
    assert model.socket_position("socket_driver").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
