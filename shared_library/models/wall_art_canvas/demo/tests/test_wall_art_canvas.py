from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("wall_art_canvas: the prefab spawns and its model's controls work")
async def test_wall_art_canvas(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.wall_art_canvas, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.set_option("frame", "white")
    assert model.option("frame") == "white"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
