from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("whole_turkey_roast: the prefab spawns and its model's controls work")
async def test_whole_turkey_roast(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.whole_turkey_roast, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("platter", "cream")
    assert model.option("platter") == "cream"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
