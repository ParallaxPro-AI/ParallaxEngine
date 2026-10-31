from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("kite: the prefab spawns and its model's controls work")
async def test_kite(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.kite, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("tail", 0.0)
    assert abs(model.joint("tail") - 0.0) < 1e-3
    model.set_option("sail_lower", "yellow")
    assert model.option("sail_lower") == "yellow"
    assert model.socket_position("socket_line").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
