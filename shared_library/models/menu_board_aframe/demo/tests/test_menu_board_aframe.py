from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("menu_board_aframe: the prefab spawns and its model's controls work")
async def test_menu_board_aframe(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.menu_board_aframe, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("fold", 13.5)
    assert abs(model.joint("fold") - 13.5) < 1e-3
    model.set_option("frame", "black")
    assert model.option("frame") == "black"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
