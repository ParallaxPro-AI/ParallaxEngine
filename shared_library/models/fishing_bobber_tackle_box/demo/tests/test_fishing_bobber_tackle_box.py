from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("fishing_bobber_tackle_box: the prefab spawns and its model's controls work")
async def test_fishing_bobber_tackle_box(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.fishing_bobber_tackle_box, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("arm_front_0", 49.9035)
    assert abs(model.joint("arm_front_0") - 49.9035) < 1e-3
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
