from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("saw_blade_rail: the prefab spawns and its model's controls work")
async def test_saw_blade_rail(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.saw_blade_rail, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("carriage", 0.0)
    assert abs(model.joint("carriage") - 0.0) < 1e-3
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
