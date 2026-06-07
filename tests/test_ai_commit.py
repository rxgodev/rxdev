"""Unit tests for the pure functions in .githooks/ai_commit.py.

These lock down the regex/semver/manifest/parsing logic that has no other
safety net. Run with:  python -m unittest discover -s tests -v
"""
import importlib.util
import os
import tempfile
import unittest

# Isolate config: point HOME at a throwaway dir and drop provider env vars so
# the module loads its built-in defaults. This makes valid_types_global and
# provider resolution deterministic regardless of the developer's real config.
_TMP_HOME = tempfile.mkdtemp(prefix="neuro-commit-test-home-")
os.environ["HOME"] = _TMP_HOME
os.environ["USERPROFILE"] = _TMP_HOME
for _v in (
    "GROQ_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY",
    "OLLAMA_API_KEY", "NEURO_COMMIT_API_KEY",
):
    os.environ.pop(_v, None)

_HERE = os.path.dirname(os.path.abspath(__file__))
_AIC = os.path.join(_HERE, "..", ".githooks", "ai_commit.py")
_spec = importlib.util.spec_from_file_location("ai_commit", _AIC)
aic = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(aic)


class TestSemver(unittest.TestCase):
    def test_parse_valid(self):
        self.assertEqual(
            aic.parse_semver("1.2.3"),
            {"major": 1, "minor": 2, "patch": 3, "prerelease": None, "build": None},
        )

    def test_parse_prerelease_build(self):
        p = aic.parse_semver("1.2.3-beta.1+build5")
        self.assertEqual(
            (p["major"], p["minor"], p["patch"], p["prerelease"], p["build"]),
            (1, 2, 3, "beta.1", "build5"),
        )

    def test_parse_invalid(self):
        for v in ["1.2", "v1.2.3", "01.2.3", "x", ""]:
            self.assertIsNone(aic.parse_semver(v), v)

    def test_bump(self):
        self.assertEqual(aic.bump_semver("1.2.3", "major"), "2.0.0")
        self.assertEqual(aic.bump_semver("1.2.3", "minor"), "1.3.0")
        self.assertEqual(aic.bump_semver("1.2.3", "patch"), "1.2.4")
        self.assertEqual(aic.bump_semver("0.0.0", "minor"), "0.1.0")

    def test_bump_invalid(self):
        self.assertIsNone(aic.bump_semver("nope", "patch"))


class TestCommitParsing(unittest.TestCase):
    def test_parse_commit_full(self):
        p = aic.parse_commit("feat(api)!: add oauth")
        self.assertEqual(p["type"], "feat")
        self.assertEqual(p["scope"], "api")
        self.assertTrue(p["breaking"])
        self.assertEqual(p["description"], "add oauth")

    def test_parse_commit_plain(self):
        p = aic.parse_commit("fix: bug")
        self.assertEqual(p["type"], "fix")
        self.assertIsNone(p["scope"])
        self.assertFalse(p["breaking"])

    def test_parse_commit_nonconforming(self):
        self.assertIsNone(aic.parse_commit("not a commit")["type"])

    def test_determine_bump_kind(self):
        self.assertEqual(aic.determine_bump_kind("feat: x"), "minor")
        self.assertEqual(aic.determine_bump_kind("fix: x"), "patch")
        self.assertEqual(aic.determine_bump_kind("feat!: x"), "major")
        self.assertEqual(aic.determine_bump_kind("docs: x"), "patch")
        self.assertEqual(aic.determine_bump_kind("fix: x\n\nBREAKING CHANGE: y"), "major")


class TestValidation(unittest.TestCase):
    def test_valid(self):
        self.assertTrue(aic.is_valid_commit_message("feat: add thing"))
        self.assertTrue(aic.is_valid_commit_message("fix(api): handle timeout"))

    def test_invalid(self):
        self.assertFalse(aic.is_valid_commit_message("feat: add thing."))  # trailing period
        self.assertFalse(aic.is_valid_commit_message("Feat: add"))         # uppercase type
        self.assertFalse(aic.is_valid_commit_message("feat: добавить"))    # cyrillic in subject
        self.assertFalse(aic.is_valid_commit_message("nope: x"))           # unknown type
        self.assertFalse(aic.is_valid_commit_message(""))


class TestCleanResponse(unittest.TestCase):
    def test_strip_markdown(self):
        self.assertEqual(aic._clean_llm_response("**feat: add thing**"), "feat: add thing")

    def test_skip_preamble(self):
        self.assertEqual(aic._clean_llm_response("Here is the commit:\nfeat: add x"), "feat: add x")

    def test_subject_and_body(self):
        self.assertEqual(
            aic._clean_llm_response("feat: add\n\nbecause reasons"),
            "feat: add\n\nbecause reasons",
        )

    def test_fallback_when_no_subject(self):
        self.assertEqual(aic._clean_llm_response("just some prose, no type"), "chore: update files")

    def test_normalize_type(self):
        self.assertEqual(aic._normalize_type("Feat: Add thing"), "feat: Add thing")
        self.assertEqual(aic._normalize_type("FIX(api): x"), "fix(api): x")


class TestManifestHandlers(unittest.TestCase):
    def test_json_peek_and_set(self):
        self.assertEqual(aic._json_handle('{"version": "1.0.0"}', "__PEEK__"), (None, "1.0.0"))
        new, old = aic._json_handle('{"version": "1.0.0"}', "2.0.0")
        self.assertEqual(old, "1.0.0")
        self.assertIn('"2.0.0"', new)

    def test_json_no_version(self):
        self.assertEqual(aic._json_handle('{"name": "x"}', "__PEEK__"), (None, None))

    def test_plain(self):
        self.assertEqual(aic._plain_handle("1.2.3\n", "__PEEK__"), (None, "1.2.3"))
        self.assertEqual(aic._plain_handle("1.2.3\n", "2.0.0"), ("2.0.0\n", "1.2.3"))
        self.assertEqual(aic._plain_handle("not a version\n", "__PEEK__"), (None, None))

    def test_yaml(self):
        self.assertEqual(aic._yaml_handle("version: 1.2.3\n", "__PEEK__"), (None, "1.2.3"))
        new, old = aic._yaml_handle("version: 1.2.3\n", "2.0.0")
        self.assertEqual(old, "1.2.3")
        self.assertIn("2.0.0", new)

    def test_toml_regex_extract(self):
        self.assertEqual(
            aic._toml_regex_extract('[package]\nversion = "1.0.0"\n', ["package"]),
            "1.0.0",
        )

    def test_gradle(self):
        self.assertEqual(aic._gradle_handle("version = '1.0.0'\n", "__PEEK__"), (None, "1.0.0"))

    def test_csproj(self):
        self.assertEqual(aic._csproj_handle("<Version>1.0.0</Version>", "__PEEK__"), (None, "1.0.0"))

    def test_gemspec(self):
        self.assertEqual(aic._gemspec_handle('spec.version = "1.0.0"', "__PEEK__"), (None, "1.0.0"))

    def test_setupcfg(self):
        self.assertEqual(aic._setupcfg_handle("version = 1.2.3\n", "__PEEK__"), (None, "1.2.3"))


class TestProviders(unittest.TestCase):
    def test_default_provider(self):
        self.assertEqual(aic.PROVIDER, "groq")
        self.assertIn("groq.com", aic.API_URL)
        self.assertTrue(aic.PROVIDER_NEEDS_KEY)

    def test_provider_registry(self):
        for name in ("groq", "openai", "openrouter", "ollama"):
            self.assertIn(name, aic.PROVIDERS)
        self.assertFalse(aic.PROVIDERS["ollama"]["needs_key"])


class TestFallback(unittest.TestCase):
    def test_fallback_message(self):
        msg = aic.generate_fallback_message("# File: src/app.py\n+print(1)")
        self.assertTrue(msg.startswith("refactor"), msg)
        self.assertIn("app.py", msg)


if __name__ == "__main__":
    unittest.main()
