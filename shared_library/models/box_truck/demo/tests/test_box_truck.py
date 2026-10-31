from parallax import Model, vec3
from parallax.physics import Rigidbody
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("box_truck: the prefab spawns and its model's controls work")
async def test_box_truck(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.box_truck, at=vec3(0, 1.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("cab_tilt", 26.0)
    assert abs(model.joint("cab_tilt") - 26.0) < 1e-3
    model.set_option("body", "flatbed")
    assert model.option("body") == "flatbed"
    assert model.socket_position("socket_driver").distance_to(thing.transform.position) < 14.72
    await game.advance(seconds=4)
    assert thing.transform.position.y < 1.0
    assert thing.get(Rigidbody).velocity.length() < 0.5
