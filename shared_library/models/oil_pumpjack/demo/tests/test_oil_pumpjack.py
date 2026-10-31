from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("oil_pumpjack: the prefab spawns and its model's controls work")
async def test_oil_pumpjack(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.oil_pumpjack, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("beam", -2.9605)
    assert abs(model.joint("beam") - -2.9605) < 1e-3
    model.set_option("paint", "yellow")
    assert model.option("paint") == "yellow"
    assert model.socket_position("wellhead").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
