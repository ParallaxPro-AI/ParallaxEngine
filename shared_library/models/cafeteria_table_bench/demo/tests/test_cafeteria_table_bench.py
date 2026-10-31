from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("cafeteria_table_bench: the prefab spawns and its model's controls work")
async def test_cafeteria_table_bench(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.cafeteria_table_bench, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("top", "grey")
    assert model.option("top") == "grey"
    assert model.socket_position("seat_f0").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
