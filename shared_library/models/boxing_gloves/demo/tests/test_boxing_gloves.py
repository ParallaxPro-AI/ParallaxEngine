from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("boxing_gloves: the prefab spawns and its model's controls work")
async def test_boxing_gloves(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.boxing_gloves, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("leather", "black")
    assert model.option("leather") == "black"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
