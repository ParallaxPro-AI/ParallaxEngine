from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("jail_cell_western: the prefab spawns and its model's controls work")
async def test_jail_cell_western(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.jail_cell_western, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("cell_door", 50.0)
    assert abs(model.joint("cell_door") - 50.0) < 1e-3
    model.set_option("furnishing", "empty")
    assert model.option("furnishing") == "empty"
    assert model.socket_position("prisoner").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
