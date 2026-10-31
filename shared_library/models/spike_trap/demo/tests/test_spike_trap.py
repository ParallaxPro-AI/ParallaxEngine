from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("spike_trap: the prefab spawns and its model's controls work")
async def test_spike_trap(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.spike_trap, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("spikes", 0.225)
    assert abs(model.joint("spikes") - 0.225) < 1e-3
    model.set_option("mounting", "wall")
    assert model.option("mounting") == "wall"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
