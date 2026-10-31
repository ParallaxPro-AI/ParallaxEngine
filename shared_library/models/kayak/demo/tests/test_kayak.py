from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("kayak: the prefab spawns and its model's controls work")
async def test_kayak(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.kayak, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("hatch_bow", 50.0)
    assert abs(model.joint("hatch_bow") - 50.0) < 1e-3
    model.set_option("colour", "yellow")
    assert model.option("colour") == "yellow"
    assert model.socket_position("seat_driver").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
