from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("barrier_arm: the prefab spawns and its model's controls work")
async def test_barrier_arm(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.barrier_arm, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("arm", 43.0)
    assert abs(model.joint("arm") - 43.0) < 1e-3
    assert model.socket_position("socket_boom_tip").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
