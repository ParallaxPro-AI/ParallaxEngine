from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("alien_interceptor: the prefab spawns and its model's controls work")
async def test_alien_interceptor(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.alien_interceptor, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("thrust", 1.75)
    assert abs(model.joint("thrust") - 1.75) < 1e-3
    model.set_option("carapace", "violet")
    assert model.option("carapace") == "violet"
    assert model.socket_position("engine_l").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
