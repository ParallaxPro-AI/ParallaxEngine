from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("general_store_counter: the prefab spawns and its model's controls work")
async def test_general_store_counter(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.general_store_counter, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("bin_0", 0.065)
    assert abs(model.joint("bin_0") - 0.065) < 1e-3
    model.set_option("wood", "pine")
    assert model.option("wood") == "pine"
    assert model.socket_position("socket_clerk").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
