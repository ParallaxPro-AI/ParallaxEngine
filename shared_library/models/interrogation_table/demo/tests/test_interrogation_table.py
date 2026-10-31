from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("interrogation_table: the prefab spawns and its model's controls work")
async def test_interrogation_table(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.interrogation_table, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("top", "laminate")
    assert model.option("top") == "laminate"
    assert model.socket_position("seat_suspect").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
