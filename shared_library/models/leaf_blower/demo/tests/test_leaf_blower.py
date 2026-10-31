from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("leaf_blower: the prefab spawns and its model's controls work")
async def test_leaf_blower(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.leaf_blower, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("throttle", 9.0)
    assert abs(model.joint("throttle") - 9.0) < 1e-3
    model.set_option("colour", "red")
    assert model.option("colour") == "red"
    assert model.socket_position("socket_grip").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
