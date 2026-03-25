# Deploy Game

Push the built game to GitHub Pages for permanent hosting.

## Usage

```bash
bash .pi/skills/deploy-game/scripts/deploy.sh <day_number> "<game_title>"
```

Example:
```bash
bash .pi/skills/deploy-game/scripts/deploy.sh 43 "Star Blaster"
```

## What it does

- Pushes the built game files to GitHub Pages
- Creates a standalone playable HTML page
- Returns the public URL where anyone can play

## Prerequisites

- Must run `build-game` first and get a successful build
- The `output/` directory must contain `index.pck`
