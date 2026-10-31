from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("upright_bass: the prefab spawns and its model's controls work")
async def test_upright_bass(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.upright_bass, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("endpin", 0.075)
    assert abs(model.joint("endpin") - 0.075) < 1e-3
    model.set_option("varnish", "dark")
    assert model.option("varnish") == "dark"
    assert model.socket_position("bow_rest").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
