from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("prison_cell: the prefab spawns and its model's controls work")
async def test_prison_cell(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.prison_cell, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("gate", 50.0)
    assert abs(model.joint("gate") - 50.0) < 1e-3
    model.set_option("furnishing", "empty")
    assert model.option("furnishing") == "empty"
    assert model.socket_position("prisoner").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
