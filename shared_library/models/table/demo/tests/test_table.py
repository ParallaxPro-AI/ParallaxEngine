from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("table: the prefab spawns and its model's controls work")
async def test_table(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.table, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("leaf", 0.275)
    assert abs(model.joint("leaf") - 0.275) < 1e-3
    model.set_option("top_shape", "round")
    assert model.option("top_shape") == "round"
    assert model.socket_position("socket_centre").distance_to(thing.transform.position) < 3.08
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
