from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("laptop: the prefab spawns and its model's controls work")
async def test_laptop(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.laptop, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("screen_hinge", 46.0)
    assert abs(model.joint("screen_hinge") - 46.0) < 1e-3
    model.set_option("screen_state", "off")
    assert model.option("screen_state") == "off"
    assert model.socket_position("socket_deck").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
