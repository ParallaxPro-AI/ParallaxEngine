from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("plyo_box: the prefab spawns and its model's controls work")
async def test_plyo_box(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.plyo_box, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("finish", "black")
    assert model.option("finish") == "black"
    assert model.socket_position("stand_top").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
