import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import test from "node:test";
import { confineToDownloads } from "./config.js";
import { download } from "./tools/files.js";
import { MoodleClient } from "./ws.js";

// No test may reach the network, even when a guard regresses.
globalThis.fetch = async () => {
  throw new Error("network disabled in tests");
};

const client = new MoodleClient({
  key: "moodle.example.fi",
  url: "https://moodle.example.fi",
  token: "SECRET",
  userid: 1,
  strategy: "manual",
  connectedAt: "test",
});

test("fileUrl signs a file on the Moodle site", () => {
  const url = client.fileUrl("https://moodle.example.fi/pluginfile.php/1/mod_resource/content/0/a.pdf");
  assert.equal(new URL(url).searchParams.get("token"), "SECRET");
});

test("fileUrl never attaches the token to another origin", () => {
  for (const url of [
    "https://evil.example/pluginfile.php/1/a.pdf",
    "https://moodle.example.fi.evil.example/a.pdf", // look-alike host
    "http://moodle.example.fi/a.pdf", // scheme downgrade
    "https://moodle.example.fi:8443/a.pdf", // other port
  ]) {
    assert.throws(() => client.fileUrl(url), /Blocked/, url);
  }
});

test("confineToDownloads allows folders inside the root", () => {
  const root = resolve("downloads-root");
  assert.equal(confineToDownloads("course1", root), join(root, "course1"));
  assert.equal(confineToDownloads(join(root, "a", "b"), root), join(root, "a", "b"));
  assert.equal(confineToDownloads("", root), root);
});

test("confineToDownloads refuses anything outside the root", () => {
  const root = resolve("downloads-root");
  for (const dest of [
    "..",
    join("..", "outside"),
    join("a", "..", "..", "outside"),
    resolve(root, "..", "outside"),
    `${root}-evil`, // shares the root's name as a prefix
  ]) {
    assert.throws(() => confineToDownloads(dest, root), /must be inside/, dest);
  }
});

test("moodle_download refuses an outside dest before fetching or writing anything", async () => {
  await assert.rejects(
    download(client, { url: "https://moodle.example.fi/pluginfile.php/1/a.pdf", dest: ".." }),
    /must be inside/,
  );
});
