from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("crib: the prefab spawns and its model's controls work")
async def test_crib(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.crib, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("front_side", 0.11)
    assert abs(model.joint("front_side") - 0.11) < 1e-3
    model.set_option("mobile", "off")
    assert model.option("mobile") == "off"
    assert model.socket_position("socket_baby").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
