from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("table_saw: the prefab spawns and its model's controls work")
async def test_table_saw(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.table_saw, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("motor_door", 52.5)
    assert abs(model.joint("motor_door") - 52.5) < 1e-3
    model.set_option("paint", "yellow")
    assert model.option("paint") == "yellow"
    assert model.socket_position("workpiece").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
