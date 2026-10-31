from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("pedestrian_signal_pole: the prefab spawns and its model's controls work")
async def test_pedestrian_signal_pole(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.pedestrian_signal_pole, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("push_button", 0.004)
    assert abs(model.joint("push_button") - 0.004) < 1e-3
    model.set_option("state", "walk")
    assert model.option("state") == "walk"
    assert model.socket_position("socket_button").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
