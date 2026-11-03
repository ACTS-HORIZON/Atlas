"""Wiki knowledge: parse -> chunk -> BM25 index -> retrieve, on two pages in
the wiki's parse-output HTML (tests/fixtures), and the mind's KNOWLEDGE block
and lookup action."""
import contextlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path

from atlas_mind import wiki
from atlas_mind.config import ROOT

import test_mind
from test_mind import until

FIX = Path(__file__).parent / "fixtures"


def sections(name):
    return wiki.parse_html((FIX / f"{name}.html").read_text(encoding="utf-8"))


def fixture_chunks():
    return wiki.chunk_page("Iron Ore", sections("Iron_Ore")) + wiki.chunk_page("Ore", sections("Ore"))


def fixture_index():
    return wiki.BM25Index.build(fixture_chunks())


class ParseTest(unittest.TestCase):
    def test_sections_and_noise(self):
        for name in ("Iron_Ore", "Ore"):  # new <div class="mw-heading"> and old <span class="mw-headline"> headings
            secs = sections(name)
            titles = [s.title for s in secs]
            text = "\n".join(s.text for s in secs)
            self.assertEqual(titles[0], "", "the lead comes first")
            self.assertTrue(any(t in ("Natural generation", "Distribution") for t in titles), titles)
            for noise in ("[edit]", "edit]", "Contents", "[1]", "MC-12345", ".mw-parser-output", "Renewable", "Coal Ore · Copper Ore"):
                self.assertNotIn(noise, text, f"{name}: {noise!r} should be stripped")
            for dropped in ("History", "Gallery", "References", "Trivia", "Navigation"):
                self.assertNotIn(dropped, titles)
            self.assertNotIn("For individual ores", text, "hatnotes go")
            self.assertNotIn("For the item obtained by smelting", text)

    def test_tables_are_text_rows(self):
        brk = next(s for s in sections("Iron_Ore") if s.title == "Breaking")
        self.assertIn("Iron Ore | 15 | 7.5 | 1.15 | 0.75 | 0.6", brk.text)
        dist = next(s for s in sections("Ore") if s.title == "Distribution")
        self.assertIn("Diamond Ore | Y -64 to 16 | Y -59 | rarely exposed to air", dist.text)
        smelt = next(s for s in sections("Iron_Ore") if s.title == "Smelting ingredient")
        self.assertIn("Raw Iron Coal Iron Ingot", smelt.text, "UI parts are separate words")

    def test_every_heading_level_is_in_the_path(self):
        secs = sections("Iron_Ore")
        brk = next(s for s in secs if s.title == "Breaking")
        self.assertEqual((brk.path, brk.level), (["Obtaining", "Breaking"], 3))
        gen = next(s for s in secs if s.title == "Natural generation")
        self.assertEqual(gen.path, ["Obtaining", "Natural generation"], "an h3 after another h3 under the same h2")
        self.assertIn("most common around level 16", gen.text)
        html = ('<div class="mw-parser-output"><h2 id="A">A</h2><p>a</p><h3 id="B">B</h3><p>b</p><h4 id="C">C</h4><p>c</p>'
                '<h3 id="D">D</h3><p>d</p><h2 id="E">E</h2><p>e</p></div>')
        self.assertEqual([" › ".join(s.path) for s in wiki.parse_html(html)], ["A", "A › B", "A › B › C", "A › D", "E"])

    def test_lists_and_keep_all(self):
        html = '<div class="mw-parser-output"><p>Intro.</p><h2><span class="mw-headline">Uses</span></h2><ul><li>Fuel</li><li>Torches</li></ul><h2><span class="mw-headline">History</span></h2><p>old</p></div>'
        secs = wiki.parse_html(html)
        self.assertEqual(secs[1].text, "- Fuel\n- Torches")
        self.assertEqual(len(secs), 2)
        self.assertEqual(len(wiki.parse_html(html, keep_all=True)), 3)


class ChunkTest(unittest.TestCase):
    def test_chunks_carry_the_full_heading_path(self):
        ch = fixture_chunks()
        titles = [c.title for c in ch]
        self.assertEqual(titles, ["Iron Ore", "Iron Ore › Obtaining › Breaking", "Iron Ore › Obtaining › Natural generation",
                                  "Iron Ore › Usage › Smelting ingredient", "Ore", "Ore › Usage", "Ore › Distribution",
                                  "Ore › Distribution › Deepslate variants"])
        self.assertEqual(len({c.id for c in ch}), len(ch), "ids are unique")
        for c in ch:
            self.assertLessEqual(wiki.tokens(c.text), 600)

    def test_long_sections_split_evenly_and_continue_with_an_ellipsis(self):
        para = "Iron ore generates in veins in stone and deepslate; a stone pickaxe mines it. " * 6
        secs = [wiki.Section("Big", 2, ["Big"], "\n".join(para for _ in range(30)))]
        ch = wiki.chunk_page("P", secs)
        sizes = [wiki.tokens(c.text) for c in ch]
        self.assertGreater(len(ch), 1)
        self.assertTrue(all(300 <= n <= 602 for n in sizes), sizes)
        self.assertTrue(all(c.title == "P › Big" for c in ch))
        self.assertFalse(ch[0].text.startswith("…"))
        self.assertTrue(all(c.text.startswith("… ") for c in ch[1:]))

    def test_each_subsection_is_its_own_chunk(self):
        secs = [wiki.Section("A", 2, ["A"], "alpha text"), wiki.Section("B", 3, ["A", "B"], "beta text"),
                wiki.Section("C", 2, ["C"], "gamma text")]
        ch = wiki.chunk_page("P", secs)
        self.assertEqual([(c.title, c.text) for c in ch], [("P › A", "alpha text"), ("P › A › B", "beta text"), ("P › C", "gamma text")])


def dense_index():
    """The real failure: Diamond Ore's generation chunk is dense with Y= tokens and beat every other ore."""
    C = wiki.Chunk
    y = " ".join(f"Y={v}" for v in range(-63, 17)) + " level altitude"
    return wiki.BM25Index.build([
        C("d1", "Diamond Ore", "Obtaining › Natural generation", f"Diamond ore generates from Y=16 to Y=-63. {y} {y}"),
        C("d2", "Diamond Ore", "Obtaining › Breaking", "Diamond ore needs an iron pickaxe. level"),
        C("i1", "Iron Ore", "Obtaining › Breaking", "Iron ore needs a stone pickaxe."),
        C("i2", "Iron Ore", "Obtaining › Natural generation", "Iron ore is most common around level 16, and common in mountains."),
        C("i3", "Iron Ore", "Usage", "Iron ore is smelted into iron ingots."),
        C("o1", "Overworld", "Environment", f"Ores by level: {y}"),
        C("a1", "Altitude", "Natural resources", f"Each ore has a level: {y}"),
        C("c1", "Coal", "Usage", "Coal is a fuel. Coal ore drops coal."),
        C("c2", "Coal Ore", "Obtaining › Natural generation", "Coal ore generates from level 0 to 192, most common at 96."),
        C("e1", "Emerald Ore", "Natural generation", "Emerald ore generates in mountains, from -16 to 320."),
    ])


class IndexTest(unittest.TestCase):
    def test_iron_ore_y_level_finds_the_iron_generation_chunk(self):
        hits = fixture_index().search("iron ore y level", 3)
        self.assertEqual(hits[0].title, "Iron Ore › Obtaining › Natural generation", [h.title for h in hits])
        self.assertIn("most common around level 16", hits[0].text)
        self.assertEqual([h.page for h in hits], ["Iron Ore", "Ore"], "one chunk per page")

    def test_the_subject_beats_a_chunk_dense_with_y_numbers(self):
        ix = dense_index()
        self.assertEqual(ix.subject("iron ore y level")[0], "iron ore")
        self.assertEqual(ix.subject("coal ore y level")[1], {"Coal Ore"})
        hits = ix.search("iron ore y level", 3)
        self.assertEqual(hits[0].title, "Iron Ore › Obtaining › Natural generation")
        self.assertEqual(len({h.page for h in hits}), 3, "at most one chunk per page")
        self.assertEqual(ix.search("coal ore y level", 1)[0].page, "Coal Ore", "the exact title beats Coal")
        self.assertEqual(ix.search("emerald ore y level", 1)[0].page, "Emerald Ore")
        self.assertEqual(ix.search("diamond ore y level", 1)[0].title, "Diamond Ore › Obtaining › Natural generation")
        self.assertEqual(ix.search("what y level", 1)[0].page in ("Diamond Ore", "Overworld", "Altitude"), True, "no subject: plain BM25")

    def test_title_field_counts_three_times_the_body(self):
        C = wiki.Chunk
        ix = wiki.BM25Index.build([C("a", "Furnace", "Fuel", "burns items"), C("b", "Torch", "Usage", "a furnace is not a torch")])
        self.assertEqual(ix.search("furnace", 1)[0].page, "Furnace")
        self.assertEqual(ix.title_weight, 3)

    def test_eval_passes_on_the_dense_index(self):
        sys.path.insert(0, str(ROOT / "scripts"))
        import wiki_index
        lines = []
        cases = [(f"{o} y level", t) for o, t in (("iron ore", "Iron Ore"), ("coal ore", "Coal Ore"), ("emerald ore", "Emerald Ore"), ("diamond ore", "Diamond Ore"))]
        self.assertEqual(wiki_index.evaluate(dense_index(), cases, out=lines.append), 0, lines)
        self.assertEqual(lines[-1], "4/4 passed")
        self.assertEqual(wiki_index.evaluate(dense_index(), [("gold ore y level", "Gold Ore")], out=lines.append), 1)
        self.assertTrue(lines[-2].startswith("FAIL  'gold ore y level'"))
        self.assertEqual(len(wiki_index.EVAL), 8)

    def test_other_questions(self):
        ix = fixture_index()
        self.assertEqual(ix.search("how do I smelt raw iron", 1)[0].title, "Iron Ore › Usage › Smelting ingredient")
        self.assertEqual(ix.search("which ore needs which pickaxe; ore usage drops", 1)[0].title, "Ore › Usage")
        self.assertEqual(ix.search("the and of", 3), [], "stop words only: nothing")

    def test_save_load_round_trip(self):
        ix = fixture_index()
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "index.json"
            ix.save(p)
            self.assertEqual(json.loads(p.read_text())["backend"], "bm25")
            r = wiki.load_retriever(p)
            self.assertEqual([h.id for h in r.search("iron ore y level")], [h.id for h in ix.search("iron ore y level")])
            self.assertIsNone(wiki.load_retriever(Path(d) / "missing.json"))
            p.write_text(json.dumps({"backend": "embeddings-v9", "chunks": []}))
            self.assertIsNone(wiki.load_retriever(p), "an unknown backend is no retriever")

    def test_excerpts_fit_the_budget(self):
        ix = fixture_index()
        q = "iron ore y level"
        pairs = wiki.excerpts(ix.search(q, 3), q, 600)
        self.assertEqual(len(pairs), 2)
        total = sum(wiki.tokens(h.title) + 2 + wiki.tokens(t) for h, t in pairs)
        self.assertLessEqual(total, 600)
        small = wiki.excerpts(ix.search(q, 3), q, 120)
        self.assertLessEqual(sum(wiki.tokens(h.title) + 2 + wiki.tokens(t) for h, t in small), 120)
        top = small[0][1]
        self.assertTrue("Iron" in top or "iron" in top, "a cut excerpt keeps the matching line")


RAW = ROOT / "data" / "wiki" / "raw"
INDEX = ROOT / "data" / "wiki" / "index.json"


@unittest.skipUnless((RAW / "Iron_Ore.html").exists() and (RAW / "Ore.html").exists(), "real pages not fetched (data/wiki/raw/)")
class RealPagesTest(unittest.TestCase):
    """On atlas, after scripts/wiki_fetch.py: the real Iron Ore and Ore pages."""

    def chunks(self, name, title):
        return wiki.chunk_page(title, wiki.parse_html((RAW / f"{name}.html").read_text(encoding="utf-8")))

    def test_iron_ore_generation_has_its_own_chunk(self):
        ch = {c.title: c for c in self.chunks("Iron_Ore", "Iron Ore")}
        self.assertIn("Iron Ore › Obtaining › Natural generation", ch, sorted(ch))
        self.assertRegex(ch["Iron Ore › Obtaining › Natural generation"].text.lower(), r"most common around level 16")

    def test_ore_distribution(self):
        titles = [c.title for c in self.chunks("Ore", "Ore")]
        self.assertIn("Ore › Distribution", titles)

    def test_iron_ore_y_level_on_the_two_pages(self):
        ix = wiki.BM25Index.build(self.chunks("Iron_Ore", "Iron Ore") + self.chunks("Ore", "Ore"))
        self.assertEqual(ix.search("iron ore y level", 1)[0].title, "Iron Ore › Obtaining › Natural generation")


@unittest.skipUnless(INDEX.exists(), "no real index (data/wiki/index.json)")
class RealIndexTest(unittest.TestCase):
    def test_eval(self):
        sys.path.insert(0, str(ROOT / "scripts"))
        import wiki_index
        lines = []
        self.assertEqual(wiki_index.evaluate(wiki.load_retriever(INDEX), out=lines.append), 0, "\n".join(lines))


class ScriptsTest(unittest.TestCase):
    def test_index_script_builds_and_queries(self):
        sys.path.insert(0, str(ROOT / "scripts"))
        import wiki_index
        with tempfile.TemporaryDirectory() as d:
            raw = Path(d) / "raw"
            raw.mkdir()
            for f in FIX.glob("*.html"):
                (raw / f.name).write_text(f.read_text(encoding="utf-8"), encoding="utf-8")
            (raw / "Iron_Ore.json").write_text(json.dumps({"title": "Iron Ore"}))
            out = Path(d) / "index.json"
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(wiki_index.main(["--raw", str(raw), "--index", str(out)]), 0)
            r = wiki.load_retriever(out)
            pages = {h.page for h in r.search("ore", 10)}
            self.assertEqual(pages, {"Iron Ore", "Ore"}, "titles from the .json sidecar, else the file name")

    def test_fetch_script_resumes_and_backs_off(self):
        sys.path.insert(0, str(ROOT / "scripts"))
        import urllib.error

        import wiki_fetch
        self.assertNotIn("@", wiki_fetch.USER_AGENT, "no contact address in the User-Agent")
        self.assertEqual(wiki_fetch.safe_name("Tutorial:Strip mining"), "Tutorial%3AStrip_mining")
        n = []

        class R:
            def __enter__(self):
                return self

            def __exit__(self, *a):
                pass

            def read(self):
                return json.dumps({"parse": {"title": "Iron Ore", "revid": 1, "text": "<p>x</p>"}}).encode()

        def fake_open(req, timeout):
            n.append(req.get_header("User-agent"))
            if len(n) == 1:
                raise urllib.error.HTTPError(req.full_url, 429, "slow down", {"Retry-After": "0"}, None)
            return R()
        orig = wiki_fetch.urllib.request.urlopen
        wiki_fetch.urllib.request.urlopen = fake_open
        try:
            with tempfile.TemporaryDirectory() as d:
                pages = Path(d) / "pages.txt"
                pages.write_text("# comment\nIron Ore\n\nIron Ore\n")
                out = Path(d) / "raw"
                with contextlib.redirect_stdout(io.StringIO()):
                    self.assertEqual(wiki_fetch.main(["--pages", str(pages), "--out", str(out), "--delay", "0"]), 0)
                self.assertEqual(len(n), 2, "one 429, one retry; the duplicate title is fetched once")
                self.assertEqual(n[0], wiki_fetch.USER_AGENT)
                self.assertTrue((out / "Iron_Ore.html").exists() and (out / "Iron_Ore.json").exists())
                with contextlib.redirect_stdout(io.StringIO()):
                    wiki_fetch.main(["--pages", str(pages), "--out", str(out), "--delay", "0"])
                self.assertEqual(len(n), 2, "resumable: a cached page is not fetched again")
        finally:
            wiki_fetch.urllib.request.urlopen = orig

    def test_page_list_size(self):
        titles = [t for t in (ROOT / "data" / "wiki" / "pages.txt").read_text().splitlines() if t.strip() and not t.startswith("#")]
        self.assertTrue(250 <= len(titles) <= 400, len(titles))
        self.assertEqual(len(titles), len(set(titles)))
        for must in ("Iron Ore", "Furnace", "Smelting", "Fuel", "Creeper", "Blaze Rod", "Eye of Ender", "Stronghold",
                     "Ender Dragon", "Elytra", "Enchanting", "Anvil", "Locator Bar", "Nether portal", "Bed", "Phantom"):
            self.assertIn(must, titles)


class MindKnowledgeTest(test_mind.MindHarness, unittest.IsolatedAsyncioTestCase):
    def traces(self, kind):
        return [m for m in self.body.received if m["type"] == "trace" and m["kind"] == kind]

    async def test_knowledge_each_turn_and_rag_trace(self):
        await self.start([
            {"thinking": "Confirm.", "action": "say", "text": "On it: iron.", "about": "t1"},
            {"thinking": "Mine iron.", "action": "call", "verb": "mine", "args": {"block": "iron_ore"}, "about": "t1"},
        ], respond=lambda c: ("failed", "mine: no iron_ore in view", None) if c["verb"] == "mine" else ("done", "said", None),
            retriever=fixture_index())
        await self.body.event("task_from_chat", {"from": "ACTS_HORIZON", "text": "@Atlas get me some iron ore"})
        await until(lambda: len(self.llm.prompts) >= 2 and len(self.traces("rag")) >= 2)
        p = self.prompt_text(0)
        self.assertIn("KNOWLEDGE (Minecraft wiki excerpts", p)
        self.assertIn("[Iron Ore", p)
        rag = self.traces("rag")[0]
        self.assertEqual(rag["v"], "0.1")
        self.assertIn("get me some iron ore", rag["data"]["query"])
        self.assertNotIn("@Atlas", rag["data"]["query"])
        self.assertTrue(rag["data"]["titles"] and all(isinstance(t, str) for t in rag["data"]["titles"]))
        self.assertLessEqual(rag["data"]["tokens"], 600)
        self.assertFalse(rag["data"]["lookup"])
        # the rag trace comes before that turn's decision
        kinds = [m["kind"] for m in self.body.received if m["type"] == "trace"]
        self.assertEqual(kinds[:2], ["rag", "decision"])
        # the verb target joins the query once a call is made
        await until(lambda: len(self.llm.prompts) >= 3 or any("mine iron ore" in t["data"]["query"] for t in self.traces("rag")))
        self.assertTrue(any("mine iron ore" in t["data"]["query"] and "no iron ore in view" in t["data"]["query"].replace("_", " ")
                            for t in self.traces("rag")), [t["data"]["query"] for t in self.traces("rag")])

    async def test_lookup_answers_next_turn(self):
        await self.start([
            {"thinking": "Where is iron?", "action": "lookup", "query": "iron ore y level"},
            {"thinking": "Got it.", "action": "note", "text": "iron peaks at y 16"},
        ], retriever=fixture_index())
        self.mind.wake("idle, something changed")
        await until(lambda: len(self.llm.prompts) >= 2)
        p = self.prompt_text(1)
        self.assertIn('LOOKUP "iron ore y level" (from the wiki', p)
        self.assertIn("Y 16", p)
        self.assertIn('your lookup "iron ore y level" is answered under LOOKUP', p)
        self.assertIn('you looked up "iron ore y level": ', p)
        rag = [t for t in self.traces("rag") if t["data"]["lookup"]]
        self.assertEqual(len(rag), 1)
        self.assertEqual(rag[0]["text"], "iron ore y level")
        self.assertTrue(rag[0]["data"]["titles"])
        self.assertLessEqual(rag[0]["data"]["tokens"], 900)

    async def test_lookups_are_capped(self):
        await self.start([
            {"thinking": "a", "action": "lookup", "query": "iron ore"},
            {"thinking": "b", "action": "lookup", "query": "iron ore"},  # same query again: rejected
            {"thinking": "b", "action": "lookup", "query": "furnace fuel"},
            {"thinking": "c", "action": "lookup", "query": "raw iron"},  # third in a row: rejected
            {"thinking": "d", "action": "wait"},
        ], retriever=fixture_index())
        self.mind.wake("go")
        await until(lambda: len(self.llm.prompts) >= 5)
        self.assertIn("the answer is under LOOKUP", self.llm.prompts[2][-1]["content"])
        self.assertIn("looked up 2 times in a row", self.llm.prompts[4][-1]["content"])
        self.assertEqual([t["text"] for t in self.traces("rag") if t["data"]["lookup"]], ["iron ore", "furnace fuel"])

    async def test_no_index_no_knowledge(self):
        await self.start([{"thinking": "look", "action": "lookup", "query": "iron"}, {"thinking": "ok", "action": "wait"}])
        self.mind.wake("go")
        await until(lambda: len(self.llm.prompts) >= 2)
        self.assertNotIn("KNOWLEDGE", self.prompt_text(0))
        self.assertIn("no wiki index on this machine", self.prompt_text(1))


if __name__ == "__main__":
    unittest.main()
