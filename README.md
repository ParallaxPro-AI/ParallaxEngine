# ParallaxEngine

## Open-source AI-native game engine

### AI-native

We believe an AI-native engine needs more than an MCP server attached to an
existing game engine. Its authoring formats and tools should be designed for
coding agents.

- **Text-based authoring.** Game logic, scenes, prefabs, and interfaces can all be
  created by writing code and data files.
- **HTML and CSS for UI.** LLMs are trained on vast amounts of HTML and CSS, so
  they can use that familiarity to build in-game interfaces.
- **Code-built 3D models.** LLMs can now create 3D models by writing code to
  generate them from primitives and meshes.

### Why use an engine instead of asking Claude Code or Codex to build a game with Three.js?

- **Structure.** Components, behaviors, systems, resources, and events give game
  code a consistent organization that the checker can validate, helping reduce
  bugs.
- **Engine features.** Rendering, physics, input, audio, animation, pathfinding,
  multiplayer, foliage, and procedural generation are already provided. The agent
  can focus on gameplay and combine existing features without implementing them
  for every game.
- **A constrained scripting API.** Game scripts use a checked subset of Python,
  transpiled to JavaScript. Restricted imports and runtime access keep scripts
  within the SDK and limit their access to browser and host APIs.

## Get started

### ParallaxPro

The easiest way to start is [ParallaxPro](https://parallaxpro.ai/). Describe your
game idea, generate and play it in your browser, then publish it to earn from
in-game purchases.

### Runta

For cloud generation with your own API key, model, and endpoint, see
[ParallaxEngine-runta](https://github.com/ParallaxPro-AI/ParallaxEngine-runta).

### Local

Follow [Getting started](docs/getting-started.md) to install the engine, set up
the authoring skill for your coding agent, and create a game.

## What's included

| Directory | Contents |
|---|---|
| `packages/` | Runtime, transpiler, checker, editor, CLI, playtest runner, and multiplayer server |
| `sdk/` | Typed Python API declarations |
| `shared_library/` | Reusable game pieces, animation clips, and over 2,000 code-built 3D models |
| `examples/` | 32 example games with source and playtests |
| `skills/parallax-game/` | Authoring instructions for coding agents |
| `docs/` | Guides, generated API reference, and diagnostic catalog |

## Documentation

- [Cheatsheet](docs/cheatsheet.md)
- [Engine concepts](docs/concepts/README.md)
- [Making a game look good](docs/concepts/visuals.md)
- [Command line](docs/cli.md)
- [API reference](docs/reference/README.md)
- [Error catalog](docs/errors/README.md)

The same documentation is published at
[parallaxpro.ai/docs/engine](https://parallaxpro.ai/docs/engine/).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development and documentation checks.
Report bugs or propose changes through
[GitHub issues](https://github.com/ParallaxPro-AI/ParallaxEngine/issues).

## License

[Apache-2.0](LICENSE). Third-party dependencies retain their own licenses; see
[NOTICE](NOTICE).
