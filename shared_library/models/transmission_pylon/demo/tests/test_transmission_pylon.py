from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("transmission_pylon: the prefab spawns and its model's controls work")
async def test_transmission_pylon(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.transmission_pylon, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("finish", "green")
    assert model.option("finish") == "green"
    assert model.socket_position("socket_line_low_l").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
