# lolesterrr.github.io

The personal site of Kajjabwangu Lester, served by GitHub Pages at https://lolesterrr.github.io.

## What's in here

- `index.html`: the whole site in one file, including Monsieur Pierre's sprites.
- `sketchbook/`: drawings copied from Pinterest.
  - `config.json`: which board to copy from, and which pins to hide.
  - `sketchbook.json`: the list of drawings the site reads.
  - `img/`: the downloaded images.
- `scripts/pinterest-sync.mjs`: copies new pins into `sketchbook/`.
- `.github/workflows/sketchbook.yml`: runs that script every hour.

## The sketchbook

1. Put the link to a public Pinterest board in `sketchbook/config.json`, under `"board"`.
2. The sync runs every hour, and right away whenever `config.json` changes. New pins show up on the site within about an hour.
3. To run it now: Actions tab, then **Sketchbook sync**, then **Run workflow**. Paste a board link into the box to check that it works without saving anything.
4. To hide a drawing, add its pin number to `"hide"`. The number is in the pin's link: `pinterest.com/pin/<number>/`.

Good to know:

- Everything on the board appears on the site, including pins saved from other people. Keep the board for your own work.
- The feed only lists recent pins, but drawings that were already copied stay on the site.
- GitHub pauses hourly jobs in repositories with no changes for 60 days, so the sync saves a small update every few weeks to stay on.
- The Sketchbook section stays hidden until the first drawing arrives.
