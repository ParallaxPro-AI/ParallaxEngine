from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("freight_boxcar: the prefab spawns and its model's controls work")
async def test_freight_boxcar(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.freight_boxcar, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("door_l", 1.625)
    assert abs(model.joint("door_l") - 1.625) < 1e-3
    model.set_option("paint", "brown")
    assert model.option("paint") == "brown"
    assert model.socket_position("socket_coupler_front").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
