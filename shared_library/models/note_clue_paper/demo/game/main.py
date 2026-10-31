"""Demo host for the note_clue_paper model piece: a ground plane to set it on."""

from parallax import Game
from parallax.plugins import physics3d
from project import Scenes

game = Game(id="note_clue_paper_demo", title="note_clue_paper demo", sdk="1.0", mode="3d",
            plugins=[physics3d()], start_scene=Scenes.yard)
