from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("kids_play_kitchen: the prefab spawns and its model's controls work")
async def test_kids_play_kitchen(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.kids_play_kitchen, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("knob_0", 135.0)
    assert abs(model.joint("knob_0") - 135.0) < 1e-3
    model.set_option("accent", "pink")
    assert model.option("accent") == "pink"
    assert model.socket_position("socket_hob_front").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
