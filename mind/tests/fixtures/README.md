# Wiki fixtures

`Iron_Ore.html` and `Ore.html` are **hand-written stand-ins**, not saved pages:
the sandbox these were made in can't reach minecraft.wiki. They follow the
structure of the wiki's `action=parse` HTML (the `mw-parser-output` div;
`Iron_Ore.html` uses the current `<div class="mw-heading">` headings, `Ore.html`
the older `<span class="mw-headline">` ones), with the usual noise: an infobox,
the table of contents, edit links, reference markers, a hatnote, a navbox, and
History/Gallery/References sections that the parser must drop.

The ore numbers in them are written from memory (Java Edition 1.18+ generation)
and are what `docs/verbs.md` marks as unverified until checked on atlas.

To replace them with the real pages (on atlas, after `scripts/wiki_fetch.py`):

    python3 scripts/wiki_fetch.py --fixtures

copies `data/wiki/raw/Iron_Ore.html` and `data/wiki/raw/Ore.html` here; the
tests are written to pass on either.

Wiki text is CC BY-NC-SA 3.0 (minecraft.wiki); personal use.
