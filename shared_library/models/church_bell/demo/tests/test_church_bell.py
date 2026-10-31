from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("church_bell: the prefab spawns and its model's controls work")
async def test_church_bell(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.church_bell, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("swing", 0.0)
    assert abs(model.joint("swing") - 0.0) < 1e-3
    model.set_option("patina", "verdigris")
    assert model.option("patina") == "verdigris"
    assert model.socket_position("rope_grip").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
