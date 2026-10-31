from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("jack_in_the_box: the prefab spawns and its model's controls work")
async def test_jack_in_the_box(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.jack_in_the_box, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("lid", 59.0)
    assert abs(model.joint("lid") - 59.0) < 1e-3
    model.set_option("box_paint", "blue")
    assert model.option("box_paint") == "blue"
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
