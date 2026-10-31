from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("fire_engine: the prefab spawns and its model's controls work")
async def test_fire_engine(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.fire_engine, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("front_locker_l", 40.0)
    assert abs(model.joint("front_locker_l") - 40.0) < 1e-3
    assert model.socket_position("seat_driver").distance_to(thing.transform.position) < 15.84
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
