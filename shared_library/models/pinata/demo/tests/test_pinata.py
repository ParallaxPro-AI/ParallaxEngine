from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("pinata: the prefab spawns and its model's controls work")
async def test_pinata(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.pinata, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("sway", 0.0)
    assert abs(model.joint("sway") - 0.0) < 1e-3
    model.set_option("body_finish", "teal")
    assert model.option("body_finish") == "teal"
    assert model.socket_position("candy").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
