from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("shipping_container: the prefab spawns and its model's controls work")
async def test_shipping_container(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.shipping_container, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("door_l", 59.0)
    assert abs(model.joint("door_l") - 59.0) < 1e-3
    model.set_option("livery", "ocean")
    assert model.option("livery") == "ocean"
    assert model.socket_position("socket_stack").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
