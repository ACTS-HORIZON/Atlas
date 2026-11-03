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
        gen = next(s for s in sections("Iron_Ore") if s.title == "Natural generation")
        self.assertIn("Main | Y -24 to 56 | Y 16 | all biomes", gen.text)
        self.assertIn("Table: Iron ore distribution", gen.text)
        dist = next(s for s in sections("Ore") if s.title == "Distribution")
        self.assertIn("Diamond Ore | Y -64 to 16 | Y -59 | rarely exposed to air", dist.text)
        smelt = next(s for s in sections("Iron_Ore") if s.title == "Smelting ingredient")
        self.assertIn("Raw Iron Coal Iron Ingot", smelt.text, "UI parts are separate words")

    def test_subsection_path(self):
        brk = next(s for s in sections("Iron_Ore") if s.title == "Breaking")
        self.assertEqual(brk.path, ["Obtaining", "Breaking"])
        self.assertEqual(brk.level, 3)

    def test_lists_and_keep_all(self):
        html = '<div class="mw-parser-output"><p>Intro.</p><h2><span class="mw-headline">Uses</span></h2><ul><li>Fuel</li><li>Torches</li></ul><h2><span class="mw-headline">History</span></h2><p>old</p></div>'
        secs = wiki.parse_html(html)
        self.assertEqual(secs[1].text, "- Fuel\n- Torches")
        self.assertEqual(len(secs), 2)
        self.assertEqual(len(wiki.parse_html(html, keep_all=True)), 3)


class ChunkTest(unittest.TestCase):
    def test_chunks_carry_page_and_section(self):
        ch = fixture_chunks()
        titles = [c.title for c in ch]
        self.assertIn("Iron Ore › Natural generation", titles)
        self.assertIn("Ore › Distribution", titles)
        self.assertIn("Iron Ore › Obtaining › Breaking", titles, "a section without its own text keeps its name in the path")
        self.assertEqual(len({c.id for c in ch}), len(ch), "ids are unique")
        for c in ch:
            self.assertLessEqual(wiki.tokens(c.text), 600)

    def test_long_sections_split_evenly(self):
        para = "Iron ore generates in veins in stone and deepslate; a stone pickaxe mines it. " * 6
        secs = [wiki.Section("Big", 2, ["Big"], "\n".join(para for _ in range(30)))]
        ch = wiki.chunk_page("P", secs)
        sizes = [wiki.tokens(c.text) for c in ch]
        self.assertGreater(len(ch), 1)
        self.assertTrue(all(300 <= n <= 600 for n in sizes), sizes)
        self.assertTrue(all(c.section == "Big" for c in ch))

    def test_small_subsections_stay_with_their_section(self):
        secs = [wiki.Section("A", 2, ["A"], "alpha text"), wiki.Section("B", 3, ["A", "B"], "beta text"),
                wiki.Section("C", 2, ["C"], "gamma text")]
        ch = wiki.chunk_page("P", secs)
        self.assertEqual([c.title for c in ch], ["P › A", "P › C"])
        self.assertEqual(ch[0].text, "alpha text\nB:\nbeta text")


class IndexTest(unittest.TestCase):
    def test_iron_ore_y_level_finds_the_distribution_chunk(self):
        hits = fixture_index().search("iron ore y level", 3)
        self.assertIn(hits[0].section, ("Distribution", "Natural generation"), [h.title for h in hits])
        self.assertIn("16", hits[0].text)
        self.assertEqual({h.title for h in hits[:2]}, {"Ore › Distribution", "Iron Ore › Natural generation"})

    def test_other_questions(self):
        ix = fixture_index()
        self.assertEqual(ix.search("how do I smelt raw iron", 1)[0].title, "Iron Ore › Usage › Smelting ingredient")
        self.assertEqual(ix.search("minimum pickaxe for diamond ore", 1)[0].title, "Ore › Mining")
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
        self.assertEqual(len(pairs), 3)
        total = sum(wiki.tokens(h.title) + 2 + wiki.tokens(t) for h, t in pairs)
        self.assertLessEqual(total, 600)
        small = wiki.excerpts(ix.search(q, 3), q, 150)
        self.assertLessEqual(sum(wiki.tokens(h.title) + 2 + wiki.tokens(t) for h, t in small), 150)
        top = small[0][1]
        self.assertTrue("Iron" in top or "iron" in top, "a cut excerpt keeps the matching line")


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


class MindKnowledgeTest(test_mind.MindTest):
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
