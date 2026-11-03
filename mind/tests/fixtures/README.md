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

They mirror the real pages' structure as indexed on atlas: Iron Ore keeps its
generation text as prose ("most common around level 16") under
"Obtaining › Natural generation" (an h3 under Obtaining, after "Breaking"); the
Ore page has "Ore › Usage" and "Ore › Distribution". The parser-only tests use
these; tests on the real pages read `data/wiki/raw/` (and the real index) and
are skipped where those don't exist.

Wiki text is CC BY-NC-SA 3.0 (minecraft.wiki); personal use.
