from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("portion_food_guac: the prefab spawns and its model's controls work")
async def test_portion_food_guac(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.portion_food_guac, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
