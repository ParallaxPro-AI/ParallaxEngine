from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("andon_stack_light: the prefab spawns and its model's controls work")
async def test_andon_stack_light(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.andon_stack_light, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("state", "green")
    assert model.option("state") == "green"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
