from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("hand_truck: the prefab spawns and its model's controls work")
async def test_hand_truck(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.hand_truck, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("tilt", 25.0)
    assert abs(model.joint("tilt") - 25.0) < 1e-3
    model.set_option("paint", "blue")
    assert model.option("paint") == "blue"
    assert model.socket_position("load").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
