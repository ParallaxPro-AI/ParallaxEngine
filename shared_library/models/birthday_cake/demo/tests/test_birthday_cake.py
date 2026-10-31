from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("birthday_cake: the prefab spawns and its model's controls work")
async def test_birthday_cake(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.birthday_cake, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("candles", "blown_out")
    assert model.option("candles") == "blown_out"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
