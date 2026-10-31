from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("exam_table_clinic: the prefab spawns and its model's controls work")
async def test_exam_table_clinic(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.exam_table_clinic, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("door_l", 47.5)
    assert abs(model.joint("door_l") - 47.5) < 1e-3
    model.set_option("upholstery", "navy")
    assert model.option("upholstery") == "navy"
    assert model.socket_position("seat_0").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
