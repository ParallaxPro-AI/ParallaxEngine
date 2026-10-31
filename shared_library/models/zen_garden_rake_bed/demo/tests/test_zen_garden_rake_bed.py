from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("zen_garden_rake_bed: the prefab spawns and its model's controls work")
async def test_zen_garden_rake_bed(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.zen_garden_rake_bed, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("gravel", "grey")
    assert model.option("gravel") == "grey"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
