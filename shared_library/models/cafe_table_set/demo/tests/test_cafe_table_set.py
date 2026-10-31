from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("cafe_table_set: the prefab spawns and its model's controls work")
async def test_cafe_table_set(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.cafe_table_set, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("top", "marble")
    assert model.option("top") == "marble"
    assert model.socket_position("seat_0").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
