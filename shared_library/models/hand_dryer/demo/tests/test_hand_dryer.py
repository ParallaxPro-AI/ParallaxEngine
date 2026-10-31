from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("hand_dryer: the prefab spawns and its model's controls work")
async def test_hand_dryer(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.hand_dryer, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("nozzle", 17.5)
    assert abs(model.joint("nozzle") - 17.5) < 1e-3
    model.set_option("finish", "stainless")
    assert model.option("finish") == "stainless"
    assert model.socket_position("air_out").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
