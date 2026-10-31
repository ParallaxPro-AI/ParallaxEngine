from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("candle: the prefab spawns and its model's controls work")
async def test_candle(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.candle, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("state", "guttering")
    assert model.option("state") == "guttering"
    assert model.socket_position("socket_flame").distance_to(thing.transform.position) < 2.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
