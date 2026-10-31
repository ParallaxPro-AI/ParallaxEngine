from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("piggy_bank: the prefab spawns and its model's controls work")
async def test_piggy_bank(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.piggy_bank, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("stopper", 0.009)
    assert abs(model.joint("stopper") - 0.009) < 1e-3
    model.set_option("glaze", "gold")
    assert model.option("glaze") == "gold"
    assert model.socket_position("slot").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
