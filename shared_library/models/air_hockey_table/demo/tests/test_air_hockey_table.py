from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("air_hockey_table: the prefab spawns and its model's controls work")
async def test_air_hockey_table(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.air_hockey_table, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("mallet_a_x", 0.0)
    assert abs(model.joint("mallet_a_x") - 0.0) < 1e-3
    model.set_option("cabinet", "red")
    assert model.option("cabinet") == "red"
    assert model.socket_position("player_a").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
