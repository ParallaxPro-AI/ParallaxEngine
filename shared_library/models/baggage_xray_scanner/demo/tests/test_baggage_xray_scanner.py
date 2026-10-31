from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("baggage_xray_scanner: the prefab spawns and its model's controls work")
async def test_baggage_xray_scanner(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.baggage_xray_scanner, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("belt", 0.1)
    assert abs(model.joint("belt") - 0.1) < 1e-3
    model.set_option("colour", "grey")
    assert model.option("colour") == "grey"
    assert model.socket_position("socket_entry").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
