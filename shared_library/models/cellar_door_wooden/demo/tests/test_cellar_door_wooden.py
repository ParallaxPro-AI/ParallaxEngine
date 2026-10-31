from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("cellar_door_wooden: the prefab spawns and its model's controls work")
async def test_cellar_door_wooden(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.cellar_door_wooden, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("door_l", 56.0)
    assert abs(model.joint("door_l") - 56.0) < 1e-3
    model.set_option("paint", "weathered")
    assert model.option("paint") == "weathered"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
