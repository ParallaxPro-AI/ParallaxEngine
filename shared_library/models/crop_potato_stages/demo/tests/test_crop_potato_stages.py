from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("crop_potato_stages: the prefab spawns and its model's controls work")
async def test_crop_potato_stages(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.crop_potato_stages, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("stage", "sprout")
    assert model.option("stage") == "sprout"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
