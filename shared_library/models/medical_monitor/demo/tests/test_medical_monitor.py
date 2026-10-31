from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("medical_monitor: the prefab spawns and its model's controls work")
async def test_medical_monitor(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.medical_monitor, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("arm", 0.0)
    assert abs(model.joint("arm") - 0.0) < 1e-3
    assert model.socket_position("socket_screen").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
