from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("ice_machine: the prefab spawns and its model's controls work")
async def test_ice_machine(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.ice_machine, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("bin_door", 47.5)
    assert abs(model.joint("bin_door") - 47.5) < 1e-3
    model.set_option("finish", "black")
    assert model.option("finish") == "black"
    assert model.socket_position("user_spot").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
