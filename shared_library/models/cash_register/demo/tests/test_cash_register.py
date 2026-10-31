from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("cash_register: the prefab spawns and its model's controls work")
async def test_cash_register(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.cash_register, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("key_bank", 4.0)
    assert abs(model.joint("key_bank") - 4.0) < 1e-3
    model.set_option("style", "antique")
    assert model.option("style") == "antique"
    assert model.socket_position("socket_drawer").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
