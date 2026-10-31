from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("incense_burner_temple: the prefab spawns and its model's controls work")
async def test_incense_burner_temple(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.incense_burner_temple, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("finish", "verdigris")
    assert model.option("finish") == "verdigris"
    assert model.socket_position("smoke").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
