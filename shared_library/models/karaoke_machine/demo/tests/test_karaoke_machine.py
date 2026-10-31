from parallax import Model, vec3
from parallax.test import playtest
from project import Prefabs, Scenes


@playtest("karaoke_machine: the prefab spawns and its model's controls work")
async def test_karaoke_machine(game):
    await game.start(scene=Scenes.yard)
    thing = game.ctx.world.spawn(Prefabs.karaoke_machine, at=vec3(0, 0.0, 0))
    await game.advance(frames=1)
    model = thing.get(Model)
    model.pose("mic_l", 0.15)
    assert abs(model.joint("mic_l") - 0.15) < 1e-3
    model.set_option("lights", "cyan")
    assert model.option("lights") == "cyan"
    assert model.socket_position("singer").distance_to(thing.transform.position) < 50.0
    await game.advance(seconds=1)
    assert thing.transform.position.is_close(vec3(0, 0, 0))
