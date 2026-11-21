import importlib.util, os, unittest
spec = importlib.util.spec_from_file_location("vsc", os.path.join(os.path.dirname(__file__), "verification-stamps-check.py"))
vsc = importlib.util.module_from_spec(spec); spec.loader.exec_module(vsc)
S = "a" * 40
JOBS = {"x-pr": S, "j1": S, "old": "b" * 40}

class T(unittest.TestCase):
    def c(self, msg, sha=S):
        return vsc.classify(sha, msg, JOBS)[0]
    def test_valid(self):
        self.assertEqual(self.c("s\n\nVerified: pa-ci-ab x"), "valid")
        self.assertEqual(self.c("s\n\nVerified: pa-job j1"), "valid")
    def test_none(self):
        self.assertEqual(self.c("s\n\nVerified: none - docs only"), "none")
        self.assertEqual(self.c("s\n\nVerified: none"), "invalid")
    def test_unstamped(self):
        self.assertEqual(self.c("s\n\nbody"), "unstamped")
    def test_invalid(self):
        self.assertEqual(self.c("Verified: pa-ci-ab x extra"), "invalid")
        self.assertEqual(self.c("Verified: foo j1"), "invalid")
        self.assertEqual(self.c("Verified: pa-job missing"), "invalid")
        self.assertEqual(self.c("Verified: pa-job old"), "invalid")
        self.assertEqual(self.c("Verified: pa-ci-ab j1"), "invalid")  # needs j1-pr
        self.assertEqual(self.c("Verified: pa-job x"), "invalid")     # exact name only
    def test_probe_failure(self):
        self.assertEqual(self.c(None), "probe-error")

if __name__ == "__main__":
    unittest.main()
