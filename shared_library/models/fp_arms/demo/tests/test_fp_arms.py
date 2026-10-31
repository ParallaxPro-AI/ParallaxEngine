from parallax import Model
from parallax.test import playtest
from parallax.viewmodel import Viewmodel
from project import Placed, Prefabs, Scenes


@playtest("fp_arms: the viewmodel spawns the arms and puts the right hand on the pistol's grip")
async def test_fp_arms(game):
    await game.start(scene=Scenes.range)
    await game.advance(seconds=0.6)
    vm = game.world.placed(Placed.eye).child("hands").get(Viewmodel)
    arms = vm.hands.get(Model)
    grip = vm.held.get(Model).socket_position("grip_r")
    assert arms.socket_position("RightHand").distance_to(grip) < 0.01
    assert arms.socket_position("palm_r").distance_to(grip) < 0.12


@playtest("fp_arms: without the prefab the viewmodel draws the engine's own arms")
async def test_procedural(game):
    await game.start(scene=Scenes.range)
    hands = game.world.placed(Placed.eye).child("hands")
    hands.get(Viewmodel).arms = None
    await game.advance(seconds=0.3)
    assert hands.get(Viewmodel).hands == hands
    assert hands.get(Model).socket_position("LeftHand").distance_to(hands.transform.position) < 1
