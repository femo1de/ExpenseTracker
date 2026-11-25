import test from "node:test";
import assert from "node:assert/strict";
import { buildConfigFileContent } from "../scripts/setup-config.mjs";
import { decryptToken } from "../js/crypto.js";
import { createGitHubStorage } from "../js/github-storage.js";
import { createExpenseEntry, upsertEntry } from "../js/ledger.js";

test("buildConfigFileContent generates valid ES module with decryptable tokens for both partners", async () => {
  const secret = "github_pat_11TEST_FAKE_TOKEN_XYZ";
  const jsSource = await buildConfigFileContent({
    appName: "Japan Trip",
    homeCurrency: "sgd",
    owner: "femo1de",
    repo: "ExpenseTracker",
    branch: "data",
    filePath: "expenses.json",
    partnerAName: "Alex",
    partnerAPassword: "pw-alex",
    partnerBName: "Sam",
    partnerBPassword: "pw-sam",
    githubToken: secret,
  });

  // Plaintext token and passwords must never appear in config.js
  assert.ok(!jsSource.includes(secret));
  assert.ok(!jsSource.includes("pw-alex"));
  assert.ok(!jsSource.includes("pw-sam"));

  // Parse exported CONFIG object from generated source
  const jsonStart = jsSource.indexOf("{");
  const jsonEnd = jsSource.lastIndexOf("}");
  const config = JSON.parse(jsSource.slice(jsonStart, jsonEnd + 1));

  assert.equal(config.homeCurrency, "SGD");
  assert.equal(config.github.owner, "femo1de");
  assert.equal(config.users.length, 2);

  assert.equal(await decryptToken(config.users[0], "pw-alex"), secret);
  assert.equal(await decryptToken(config.users[1], "pw-sam"), secret);
  await assert.rejects(() => decryptToken(config.users[0], "pw-sam"), /Incorrect password/);
});

test("createGitHubStorage retries on 409 conflict and preserves concurrent entries", async () => {
  const originalFetch = globalThis.fetch;
  let remoteSha = "sha_v1";
  const existingEntry = createExpenseEntry(
    {
      title: "Partner B Coffee",
      date: "2026-11-25",
      amount: 10,
      currency: "SGD",
      fxRate: 1,
      paidBy: "partnerB",
      splitMode: "even",
    },
    ["partnerA", "partnerB"],
    "SGD"
  );

  let remoteLedger = { version: 1, homeCurrency: "SGD", entries: [] };
  let putCalls = 0;

  globalThis.fetch = async (url, options = {}) => {
    const method = options.method || "GET";
    if (method === "GET") {
      return new Response(
        JSON.stringify({
          sha: remoteSha,
          content: Buffer.from(JSON.stringify(remoteLedger), "utf8").toString("base64"),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    if (method === "PUT") {
      putCalls += 1;
      const body = JSON.parse(options.body);
      if (putCalls === 1) {
        // Simulate partner B saving concurrently before partner A's PUT lands
        remoteLedger = { version: 1, homeCurrency: "SGD", entries: [existingEntry] };
        remoteSha = "sha_v2";
        return new Response(JSON.stringify({ message: "Conflict" }), { status: 409 });
      }
      assert.equal(body.sha, "sha_v2");
      remoteLedger = JSON.parse(Buffer.from(body.content, "base64").toString("utf8"));
      remoteSha = "sha_v3";
      return new Response(JSON.stringify({ content: { sha: remoteSha } }), { status: 200 });
    }

    throw new Error(`Unexpected request ${method} ${url}`);
  };

  try {
    const storage = createGitHubStorage({
      owner: "femo1de",
      repo: "ExpenseTracker",
      branch: "data",
      filePath: "expenses.json",
      token: "fake-token",
      homeCurrency: "SGD",
    });

    await storage.load();
    const myEntry = createExpenseEntry(
      {
        title: "Partner A Lunch",
        date: "2026-11-25",
        amount: 24,
        currency: "SGD",
        fxRate: 1,
        paidBy: "partnerA",
        splitMode: "even",
      },
      ["partnerA", "partnerB"],
      "SGD"
    );

    const { data } = await storage.mutate((ledger) => upsertEntry(ledger, myEntry), "Add lunch");
    assert.equal(putCalls, 2);
    assert.equal(data.entries.length, 2);
    assert.ok(data.entries.some((e) => e.id === existingEntry.id));
    assert.ok(data.entries.some((e) => e.id === myEntry.id));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createGitHubStorage auto-bootstraps orphan data branch when missing", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];

  globalThis.fetch = async (url, options = {}) => {
    const method = options.method || "GET";
    calls.push(`${method} ${new URL(url).pathname}`);

    if (method === "GET") {
      return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    }
    if (method === "PUT") {
      return new Response(JSON.stringify({ message: "Branch data not found" }), { status: 404 });
    }
    if (url.endsWith("/git/blobs")) {
      return new Response(JSON.stringify({ sha: "blob_sha_1" }), { status: 201 });
    }
    if (url.endsWith("/git/trees")) {
      return new Response(JSON.stringify({ sha: "tree_sha_1" }), { status: 201 });
    }
    if (url.endsWith("/git/commits")) {
      return new Response(JSON.stringify({ sha: "commit_sha_1" }), { status: 201 });
    }
    if (url.endsWith("/git/refs")) {
      const body = JSON.parse(options.body);
      assert.equal(body.ref, "refs/heads/data");
      return new Response(JSON.stringify({ ref: body.ref }), { status: 201 });
    }
    throw new Error(`Unexpected request ${method} ${url}`);
  };

  try {
    const storage = createGitHubStorage({
      owner: "femo1de",
      repo: "ExpenseTracker",
      branch: "data",
      filePath: "expenses.json",
      token: "fake-token",
      homeCurrency: "SGD",
    });

    const entry = createExpenseEntry(
      {
        title: "First Expense",
        date: "2026-11-25",
        amount: 15,
        currency: "SGD",
        fxRate: 1,
        paidBy: "partnerA",
        splitMode: "even",
      },
      ["partnerA", "partnerB"],
      "SGD"
    );

    const { data, sha } = await storage.mutate((ledger) => upsertEntry(ledger, entry), "Init data");
    assert.equal(sha, "blob_sha_1");
    assert.equal(data.entries.length, 1);
    assert.ok(calls.some((c) => c.endsWith("/git/refs")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
