from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("chandelier: the prefab spawns and its model's controls work")
async def test_chandelier(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.chandelier, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("arm_count", "three")
    assert model.option("arm_count") == "three"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
