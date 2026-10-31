from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("ufo: the prefab spawns and its model's controls work")
async def test_ufo(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.ufo, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("tractor_beam", 6.0005)
    assert abs(model.joint("tractor_beam") - 6.0005) < 1e-3
    model.set_option("finish", "gunmetal")
    assert model.option("finish") == "gunmetal"
    assert model.socket_position("socket_tractor_beam").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
