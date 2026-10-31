from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("space_capsule: the prefab spawns and its model's controls work")
async def test_space_capsule(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.space_capsule, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("hatch", 50.0)
    assert abs(model.joint("hatch") - 50.0) < 1e-3
    model.set_option("canopy", "glazed")
    assert model.option("canopy") == "glazed"
    assert model.socket_position("socket_dock").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
