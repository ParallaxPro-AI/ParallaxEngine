from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("binoculars: the prefab spawns and its model's controls work")
async def test_binoculars(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.binoculars, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("half_l", 4.0)
    assert abs(model.joint("half_l") - 4.0) < 1e-3
    model.set_option("colour", "black")
    assert model.option("colour") == "black"
    assert model.socket_position("socket_eye").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
