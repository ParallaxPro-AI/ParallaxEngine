from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("high_speed_train: the prefab spawns and its model's controls work")
async def test_high_speed_train(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.high_speed_train, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("door_lf_a", 0.325)
    assert abs(model.joint("door_lf_a") - 0.325) < 1e-3
    assert model.socket_position("socket_coupler_front").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
