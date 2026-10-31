from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("crosswalk_section: the prefab spawns and its model's controls work")
async def test_crosswalk_section(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.crosswalk_section, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("markings", "plain")
    assert model.option("markings") == "plain"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
