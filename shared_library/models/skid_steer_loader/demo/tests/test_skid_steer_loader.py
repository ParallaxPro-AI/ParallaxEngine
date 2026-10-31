from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("skid_steer_loader: the prefab spawns and its model's controls work")
async def test_skid_steer_loader(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.skid_steer_loader, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("tailgate", 50.0)
    assert abs(model.joint("tailgate") - 50.0) < 1e-3
    model.set_option("paint", "white")
    assert model.option("paint") == "white"
    assert model.socket_position("seat_driver").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
