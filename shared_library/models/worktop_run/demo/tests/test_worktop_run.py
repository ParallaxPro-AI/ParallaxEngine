from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("worktop_run: the prefab spawns and its model's controls work")
async def test_worktop_run(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.worktop_run, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("length", "1200mm")
    assert model.option("length") == "1200mm"
    assert model.socket_position("socket_worktop").distance_to(thing.transform.position) < 3.98
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
