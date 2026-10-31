from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("coffee_beans_sack: the prefab spawns and its model's controls work")
async def test_coffee_beans_sack(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.coffee_beans_sack, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("print", "red")
    assert model.option("print") == "red"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
