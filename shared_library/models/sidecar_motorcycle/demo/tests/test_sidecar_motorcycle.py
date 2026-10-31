from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("sidecar_motorcycle: the prefab spawns and its model's controls work")
async def test_sidecar_motorcycle(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.sidecar_motorcycle, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("bike_steer", 0.0)
    assert abs(model.joint("bike_steer") - 0.0) < 1e-3
    assert model.socket_position("seat_driver").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
