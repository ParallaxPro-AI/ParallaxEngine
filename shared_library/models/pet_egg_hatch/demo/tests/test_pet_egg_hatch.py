from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("pet_egg_hatch: the prefab spawns and its model's controls work")
async def test_pet_egg_hatch(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.pet_egg_hatch, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("cap", 37.5)
    assert abs(model.joint("cap") - 37.5) < 1e-3
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
