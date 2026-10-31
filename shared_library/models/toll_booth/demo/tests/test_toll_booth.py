from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("toll_booth: the prefab spawns and its model's controls work")
async def test_toll_booth(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.toll_booth, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("barrier_arm", 43.0)
    assert abs(model.joint("barrier_arm") - 43.0) < 1e-3
    model.set_option("band_colour", "blue")
    assert model.option("band_colour") == "blue"
    assert model.socket_position("socket_attendant").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
