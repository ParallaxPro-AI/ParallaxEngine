from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("exhibit_plaque: the prefab spawns and its model's controls work")
async def test_exhibit_plaque(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.exhibit_plaque, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("label", "do_not_touch")
    assert model.option("label") == "do_not_touch"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
