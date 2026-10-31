from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("buffer_stop: the prefab spawns and its model's controls work")
async def test_buffer_stop(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.buffer_stop, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("buffers", 0.06)
    assert abs(model.joint("buffers") - 0.06) < 1e-3
    model.set_option("sleepers", "timber")
    assert model.option("sleepers") == "timber"
    assert model.socket_position("joint_a").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
