from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("tower_plinth: the prefab spawns and its model's controls work")
async def test_tower_plinth(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.tower_plinth, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("team", "blue")
    assert model.option("team") == "blue"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
