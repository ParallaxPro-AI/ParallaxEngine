from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("fox: the prefab spawns and its model's controls work")
async def test_fox(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.fox, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("coat", "cross")
    assert model.option("coat") == "cross"
    assert model.socket_position("head_top").distance_to(thing.transform.position) < 2.01
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
