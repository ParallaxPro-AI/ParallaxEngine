from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("passenger_ferry: the prefab spawns and its model's controls work")
async def test_passenger_ferry(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.passenger_ferry, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("bow_ramp", 49.0)
    assert abs(model.joint("bow_ramp") - 49.0) < 1e-3
    assert model.socket_position("eye_point").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
