from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("dock_crane_wooden: the prefab spawns and its model's controls work")
async def test_dock_crane_wooden(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.dock_crane_wooden, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("fall", 1.6094)
    assert abs(model.joint("fall") - 1.6094) < 1e-3
    model.set_option("load", "empty")
    assert model.option("load") == "empty"
    assert model.socket_position("operator").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
