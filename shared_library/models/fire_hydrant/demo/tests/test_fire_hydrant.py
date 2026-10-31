from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("fire_hydrant: the prefab spawns and its model's controls work")
async def test_fire_hydrant(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.fire_hydrant, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("caps", 50.0)
    assert abs(model.joint("caps") - 50.0) < 1e-3
    model.set_option("pillar", "uk")
    assert model.option("pillar") == "uk"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
