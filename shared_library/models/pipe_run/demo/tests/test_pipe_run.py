from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("pipe_run: the prefab spawns and its model's controls work")
async def test_pipe_run(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.pipe_run, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("valve_wheel_l", 30.0)
    assert abs(model.joint("valve_wheel_l") - 30.0) < 1e-3
    model.set_option("finish", "steel")
    assert model.option("finish") == "steel"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
