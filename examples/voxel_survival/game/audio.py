"""The template's sound cues (its audio cue map), each a catalog sound linked by URL
(config/audio.json). Breaking any block plays the template's one mining click (each
block's `sound`); volumes are the template's, at each call."""

from parallax import SoundRef, config


@config("audio")
class Sounds:
    craft: SoundRef
    pickup: SoundRef
    mob_death: SoundRef
    hurt: SoundRef
    death: SoundRef
    hit: SoundRef
