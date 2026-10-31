from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("utility_pole: the prefab spawns and its model's controls work")
async def test_utility_pole(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.utility_pole, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("fitment", "telecom")
    assert model.option("fitment") == "telecom"
    assert model.socket_position("line_top").distance_to(thing.transform.position) < 15.08
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
