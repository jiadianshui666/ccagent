import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const suiteDir = join(repoRoot, "tests", "fixtures", "retrieval-manifests");

test("retrieval manifest fixtures are complete, portable, and consistent", async () => {
  const registry = JSON.parse(await readFile(join(suiteDir, "index.json"), "utf8"));

  assert.equal(registry.version, 1);
  assert.ok(registry.repositories.length >= 3, "expects manifests for several real repositories");

  const ids = new Set<string>();

  for (const repository of registry.repositories) {
    assert.ok(repository.id, "registry ids must be named");
    assert.match(repository.id, /^[a-z0-9-]+$/);
    assert.equal(ids.has(repository.id), false, "registry ids must be unique");
    ids.add(repository.id);
    assert.match(repository.npmVersion, /^\d+\.\d+\.\d+/);
    assert.ok(repository.manifest.endsWith(".json"));

    const manifest = JSON.parse(await readFile(join(suiteDir, repository.manifest), "utf8"));

    assert.equal(manifest.version, 1);
    assert.ok(Number.isInteger(manifest.k) && manifest.k >= 1 && manifest.k <= 10);
    assert.ok(Array.isArray(manifest.cases) && manifest.cases.length > 0);

    for (const [key, threshold] of Object.entries(manifest.thresholds as Record<string, unknown>)) {
      assert.equal(typeof threshold, "number", `threshold ${key} must be numeric`);
      assert.ok((threshold as number) >= 0 && (threshold as number) <= 1, `threshold ${key} must be in [0,1]`);
    }

    for (const testCase of manifest.cases) {
      assert.ok(testCase.name && testCase.query, "cases need names and queries");
      assert.ok(Array.isArray(testCase.expected) && testCase.expected.length > 0);
      assert.equal(testCase.expected.length, new Set(testCase.expected).size);

      for (const expected of testCase.expected) {
        assert.equal(typeof expected, "string");
        assert.equal(expected.includes("\\"), false, "expected paths must use forward slashes");
        assert.equal(expected.startsWith("/"), false, "expected paths must be repo-relative");
        assert.equal(expected.split("/").includes(".."), false, "expected paths must stay inside the repo");
      }
    }
  }

  const fixtureFiles: string[] = [];

  for (const name of await readdir(suiteDir)) {
    if (name.endsWith(".json")) {
      fixtureFiles.push(name);
    }
  }

  assert.deepEqual(fixtureFiles.sort(), [
    "debug.json",
    "index.json",
    "kleur.json",
    "picomatch.json",
  ]);
});

test("retrieval manifest runner gates a repository through index build and eval", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "ccagent-retrieval-runner-"));
  const miniRepo = join(temporaryRoot, "mini");
  const miniSuiteDir = join(temporaryRoot, "suite");

  try {
    await mkdir(miniRepo, { recursive: true });
    await mkdir(miniSuiteDir, { recursive: true });
    await writeFile(
      join(miniRepo, "src-alpha.js"),
      "// unique marker\nfunction alphaBeta(input) {\n  return input.toUpperCase();\n}\nexports.alphaBeta = alphaBeta;\n",
      "utf8",
    );
    await writeFile(
      join(miniRepo, "src-gamma.js"),
      "// unique second marker\nfunction gammaDelta(input) {\n  return input.length;\n}\nexports.gammaDelta = gammaDelta;\n",
      "utf8",
    );
    await writeFile(
      join(miniSuiteDir, "index.json"),
      `${JSON.stringify({
        version: 1,
        repositories: [{
          id: "mini",
          package: "mini-fixture",
          npmVersion: "1.0.0",
          manifest: "mini.json",
          notes: "Synthetic fixture repository used by the runner test.",
        }],
      })}\n`,
      "utf8",
    );
    await writeFile(
      join(miniSuiteDir, "mini.json"),
      `${JSON.stringify({
        version: 1,
        k: 2,
        thresholds: {
          lexicalRecallAtK: 1,
          lexicalMrr: 1,
          automaticRecallAtK: 0,
          automaticMrr: 0,
        },
        cases: [
          { name: "alpha", query: "alphaBeta", expected: ["src-alpha.js"] },
          { name: "gamma", query: "gammaDelta", expected: ["src-gamma.js"] },
        ],
      })}\n`,
      "utf8",
    );

    const runner = spawnSync(
      process.execPath,
      [
        join(repoRoot, "scripts", "retrieval-manifests-run.mjs"),
        "mini",
        "--suite-dir",
        miniSuiteDir,
        "--target",
        miniRepo,
        "--tsx",
        "--entry",
        join(repoRoot, "src", "index.ts"),
      ],
      {
        cwd: repoRoot,
        encoding: "utf8",
        windowsHide: true,
        timeout: 120_000,
      },
    );

    assert.equal(runner.signal, null);
    assert.equal(runner.status, 0, runner.stderr || runner.stdout);

    const manifestOnDisk = JSON.parse(await readFile(join(miniRepo, ".ccagent", "retrieval-eval.json"), "utf8"));
    assert.equal(manifestOnDisk.cases.length, 2);

    assert.match(runner.stdout, /SUITE mini status=pass/);
    assert.match(runner.stdout, /Summary: 1\/1 suites passed/);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("retrieval manifest runner fails fast on unknown repository ids", async () => {
  const runner = spawnSync(
    process.execPath,
    [join(repoRoot, "scripts", "retrieval-manifests-run.mjs"), "no-such-repo", "--fetch"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
    },
  );

  assert.equal(runner.status, 2);
  assert.match(runner.stderr, /Unknown repository id/);
});
