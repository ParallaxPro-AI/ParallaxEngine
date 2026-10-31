from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("check_in_counter: the prefab spawns and its model's controls work")
async def test_check_in_counter(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.check_in_counter, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("drawer", 0.16)
    assert abs(model.joint("drawer") - 0.16) < 1e-3
    model.set_option("finish", "walnut")
    assert model.option("finish") == "walnut"
    assert model.socket_position("socket_passenger").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
