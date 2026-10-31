from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("assembly_robot_cell: the prefab spawns and its model's controls work")
async def test_assembly_robot_cell(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.assembly_robot_cell, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("access_door", 50.0)
    assert abs(model.joint("access_door") - 50.0) < 1e-3
    model.set_option("robot", "yellow")
    assert model.option("robot") == "yellow"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
