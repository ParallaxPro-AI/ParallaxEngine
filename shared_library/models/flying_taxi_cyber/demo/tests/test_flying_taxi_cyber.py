from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("flying_taxi_cyber: the prefab spawns and its model's controls work")
async def test_flying_taxi_cyber(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.flying_taxi_cyber, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("fan_f_l", 17.5)
    assert abs(model.joint("fan_f_l") - 17.5) < 1e-3
    assert model.socket_position("seat_driver").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
