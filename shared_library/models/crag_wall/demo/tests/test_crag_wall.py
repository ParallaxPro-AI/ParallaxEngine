from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("crag_wall: the prefab spawns and its model's controls work")
async def test_crag_wall(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.crag_wall, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("crest", "notch")
    assert model.option("crest") == "notch"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
