from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("rope_barrier: the prefab spawns and its model's controls work")
async def test_rope_barrier(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.rope_barrier, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("rope_color", "navy")
    assert model.option("rope_color") == "navy"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
