from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("house_railing_balcony: the prefab spawns and its model's controls work")
async def test_house_railing_balcony(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.house_railing_balcony, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("style", "iron")
    assert model.option("style") == "iron"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
