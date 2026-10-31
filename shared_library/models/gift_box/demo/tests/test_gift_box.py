from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("gift_box: the prefab spawns and its model's controls work")
async def test_gift_box(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.gift_box, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("lid", 57.5)
    assert abs(model.joint("lid") - 57.5) < 1e-3
    model.set_option("wrap", "green")
    assert model.option("wrap") == "green"
    assert model.socket_position("socket_cavity").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
