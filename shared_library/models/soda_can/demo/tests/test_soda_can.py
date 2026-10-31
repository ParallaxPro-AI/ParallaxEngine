from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("soda_can: the prefab spawns and its model's controls work")
async def test_soda_can(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.soda_can, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("tab", 35.0)
    assert abs(model.joint("tab") - 35.0) < 1e-3
    model.set_option("colour", "blue")
    assert model.option("colour") == "blue"
    assert model.socket_position("socket_grip").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
