from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("rotary_phone: the prefab spawns and its model's controls work")
async def test_rotary_phone(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.rotary_phone, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("dial", 150.0)
    assert abs(model.joint("dial") - 150.0) < 1e-3
    model.set_option("body_colour", "ivory")
    assert model.option("body_colour") == "ivory"
    assert model.socket_position("socket_handset").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
