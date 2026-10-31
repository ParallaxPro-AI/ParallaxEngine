from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("lunar_rover: the prefab spawns and its model's controls work")
async def test_lunar_rover(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.lunar_rover, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("hand_controller", 0.0)
    assert abs(model.joint("hand_controller") - 0.0) < 1e-3
    model.set_option("fenders", "grey")
    assert model.option("fenders") == "grey"
    assert model.socket_position("seat_driver").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
