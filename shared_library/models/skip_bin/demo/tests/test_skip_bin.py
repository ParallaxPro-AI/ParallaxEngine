from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("skip_bin: the prefab spawns and its model's controls work")
async def test_skip_bin(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.skip_bin, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("paint", "green")
    assert model.option("paint") == "green"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
