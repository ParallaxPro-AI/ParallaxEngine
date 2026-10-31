# Getting started

Install the engine, create a small game, and play it in the browser editor. You
can write the files yourself or use a coding agent with the authoring skill.

## Install

You need Node.js 22.18 or newer, pnpm 9.15.0, and Python 3.12 or newer available
as `python3`. Python runs the transpiler; it needs no additional Python packages.

```sh
git clone https://github.com/ParallaxPro-AI/ParallaxEngine.git
cd ParallaxEngine
pnpm install --frozen-lockfile
```

## Set up the authoring skill

Install the bundled `parallax-game` skill for your coding agent:

```sh
npx skills add . --skill parallax-game
```

Choose your coding agent in the installer, then open the engine checkout in that
agent. The installer requires Node.js 22.20 or newer. You can also tell the agent
to read `skills/parallax-game/SKILL.md` directly.

Give the agent the paths to the engine and the game you want to create. For example:

> Read skills/parallax-game/SKILL.md and create a 2D asteroid dodger in ../my-game.
> This folder is the engine checkout. Add scoring and a restart button, and
> test movement, collisions, and restarting.

The engine itself does not call a language model. Your coding agent supplies
the model connection and edits the project files.

## Create and play

To create a starter yourself, use the CLI:

```sh
pnpm parallax new ../my-game --template blank-2d
pnpm parallax check ../my-game
pnpm parallax test ../my-game
pnpm parallax edit ../my-game
```

The editor opens in your browser. Click **Play** and move the square with WASD or
the arrow keys. Stop the editor server with Ctrl+C in the terminal.

`blank-3d` starts with a movable box, camera, and ground. `arcade-2d` adds falling
rocks, scoring, a game-over panel, and retry. Choose one with `--template`, or
start from an [example game](examples.md).

Edit Python and HTML/CSS in your text editor. The browser editor edits scenes
and prefabs and saves JSON changes to the project. It watches project files and
rebuilds when they change.

## Next steps

[Project layout](concepts/project-layout.md) explains the generated game.
[Engine concepts](concepts/README.md) cover the authoring model, and the
[CLI reference](cli.md) explains commands and options.
