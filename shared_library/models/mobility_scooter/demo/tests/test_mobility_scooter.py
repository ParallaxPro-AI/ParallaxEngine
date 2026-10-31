from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("mobility_scooter: the prefab spawns and its model's controls work")
async def test_mobility_scooter(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.mobility_scooter, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("seat_swivel", 0.0)
    assert abs(model.joint("seat_swivel") - 0.0) < 1e-3
    model.set_option("paint", "blue")
    assert model.option("paint") == "blue"
    assert model.socket_position("seat_driver").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
