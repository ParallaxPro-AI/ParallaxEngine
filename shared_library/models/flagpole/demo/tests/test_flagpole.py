from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("flagpole: the prefab spawns and its model's controls work")
async def test_flagpole(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.flagpole, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("flag_raise", -2.69)
    assert abs(model.joint("flag_raise") - -2.69) < 1e-3
    model.set_option("design", "canton")
    assert model.option("design") == "canton"
    assert model.socket_position("socket_base").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
