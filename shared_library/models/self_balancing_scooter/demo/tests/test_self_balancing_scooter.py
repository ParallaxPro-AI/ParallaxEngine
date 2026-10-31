from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("self_balancing_scooter: the prefab spawns and its model's controls work")
async def test_self_balancing_scooter(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.self_balancing_scooter, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("half_l", 0.0)
    assert abs(model.joint("half_l") - 0.0) < 1e-3
    model.set_option("shell_colour", "black")
    assert model.option("shell_colour") == "black"
    assert model.socket_position("seat_stand").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
