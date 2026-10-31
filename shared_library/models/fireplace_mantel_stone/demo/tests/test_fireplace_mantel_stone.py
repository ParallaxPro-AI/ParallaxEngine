from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("fireplace_mantel_stone: the prefab spawns and its model's controls work")
async def test_fireplace_mantel_stone(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.fireplace_mantel_stone, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("state", "cold")
    assert model.option("state") == "cold"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
