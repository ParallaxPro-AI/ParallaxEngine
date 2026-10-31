from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("paper_dart: the prefab spawns and its model's controls work")
async def test_paper_dart(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.paper_dart, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("crease_wing_l", 13.5)
    assert abs(model.joint("crease_wing_l") - 13.5) < 1e-3
    model.set_option("team", "blue")
    assert model.option("team") == "blue"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
