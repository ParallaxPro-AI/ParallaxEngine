from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("tanker_truck: the prefab spawns and its model's controls work")
async def test_tanker_truck(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.tanker_truck, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("manhole_lid_0", 50.0)
    assert abs(model.joint("manhole_lid_0") - 50.0) < 1e-3
    model.set_option("body", "stainless")
    assert model.option("body") == "stainless"
    assert model.socket_position("socket_driver").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
