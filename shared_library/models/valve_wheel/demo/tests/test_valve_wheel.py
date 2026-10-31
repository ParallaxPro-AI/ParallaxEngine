from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("valve_wheel: the prefab spawns and its model's controls work")
async def test_valve_wheel(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.valve_wheel, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("indicator", 0.08)
    assert abs(model.joint("indicator") - 0.08) < 1e-3
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
