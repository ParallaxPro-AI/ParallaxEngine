from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("luxury_coffee_table: the prefab spawns and its model's controls work")
async def test_luxury_coffee_table(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.luxury_coffee_table, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("side_table", 0.2)
    assert abs(model.joint("side_table") - 0.2) < 1e-3
    model.set_option("styling", "bare")
    assert model.option("styling") == "bare"
    assert model.socket_position("surface_top").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
