from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("revolver: the prefab spawns and its model's controls work")
async def test_revolver(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.revolver, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("cylinder", 41.0)
    assert abs(model.joint("cylinder") - 41.0) < 1e-3
    model.set_option("barrel", "snub")
    assert model.option("barrel") == "snub"
    assert model.socket_position("grip_r").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
