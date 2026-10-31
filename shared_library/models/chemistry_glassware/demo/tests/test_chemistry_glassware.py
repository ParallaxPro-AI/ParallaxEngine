from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("chemistry_glassware: the prefab spawns and its model's controls work")
async def test_chemistry_glassware(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.chemistry_glassware, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("contents", "empty")
    assert model.option("contents") == "empty"
    assert model.socket_position("socket_flask").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
