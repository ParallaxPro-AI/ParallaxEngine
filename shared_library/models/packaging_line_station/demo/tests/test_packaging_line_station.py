from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("packaging_line_station: the prefab spawns and its model's controls work")
async def test_packaging_line_station(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.packaging_line_station, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("head", 0.175)
    assert abs(model.joint("head") - 0.175) < 1e-3
    model.set_option("paint", "grey")
    assert model.option("paint") == "grey"
    assert model.socket_position("socket_infeed").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
