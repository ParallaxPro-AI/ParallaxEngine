from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("townhouse_row: the prefab spawns and its model's controls work")
async def test_townhouse_row(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.townhouse_row, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("door_a", 46.0)
    assert abs(model.joint("door_a") - 46.0) < 1e-3
    model.set_option("brick", "grey_stock")
    assert model.option("brick") == "grey_stock"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
