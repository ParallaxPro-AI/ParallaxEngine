from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("duck: the prefab spawns and its model's controls work")
async def test_duck(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.duck, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("head", "brown")
    assert model.option("head") == "brown"
    assert model.socket_position("head_top").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
