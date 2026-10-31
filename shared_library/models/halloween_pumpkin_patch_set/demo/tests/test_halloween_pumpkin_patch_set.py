from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("halloween_pumpkin_patch_set: the prefab spawns and its model's controls work")
async def test_halloween_pumpkin_patch_set(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.halloween_pumpkin_patch_set, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("lantern", "unlit")
    assert model.option("lantern") == "unlit"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
