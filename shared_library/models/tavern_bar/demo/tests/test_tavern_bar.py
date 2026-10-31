from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("tavern_bar: the prefab spawns and its model's controls work")
async def test_tavern_bar(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.tavern_bar, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("bar_flap", 89.5)
    assert abs(model.joint("bar_flap") - 89.5) < 1e-3
    model.set_option("wood", "honey")
    assert model.option("wood") == "honey"
    assert model.socket_position("serve_0").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
