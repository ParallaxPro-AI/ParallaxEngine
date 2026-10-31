from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("log_cabin: the prefab spawns and its model's controls work")
async def test_log_cabin(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.log_cabin, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("table_leaf", 0.275)
    assert abs(model.joint("table_leaf") - 0.275) < 1e-3
    model.set_option("log_finish", "weathered_grey")
    assert model.option("log_finish") == "weathered_grey"
    assert model.socket_position("socket_porch").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
