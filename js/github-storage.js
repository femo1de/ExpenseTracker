import { bytesToBase64, base64ToBytes } from "./crypto.js";
import { createEmptyLedger, normalizeLedger } from "./ledger.js";

const GITHUB_API_BASE = "https://api.github.com";
const DEMO_STORAGE_KEY = "trip_expenses_demo_ledger_v1";
const MAX_CONFLICT_RETRIES = 3;

function encodeUtf8ToBase64(text) {
  return bytesToBase64(new TextEncoder().encode(text));
}

function decodeBase64ToUtf8(base64) {
  return new TextDecoder().decode(base64ToBytes(base64.replace(/\s+/g, "")));
}

function createGithubHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };
}

async function parseErrorMessage(response) {
  try {
    const body = await response.json();
    return body?.message || `GitHub API error (${response.status})`;
  } catch {
    return `GitHub API error (${response.status})`;
  }
}

export function createGitHubStorage({ owner, repo, branch, filePath, token, homeCurrency = "SGD" }) {
  const encodedPath = filePath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const contentsUrl = `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodedPath}`;
  const headers = createGithubHeaders(token);

  let cachedSha = null;
  let cachedData = null;

  async function apiRequest(url, options = {}) {
    const response = await fetch(url, {
      cache: "no-store",
      ...options,
      headers: {
        ...headers,
        ...(options.headers || {}),
      },
    });
    return response;
  }

  async function load() {
    const url = `${contentsUrl}?ref=${encodeURIComponent(branch)}`;
    const response = await apiRequest(url, { method: "GET" });

    if (response.status === 404) {
      cachedSha = null;
      cachedData = createEmptyLedger(homeCurrency);
      return { data: structuredClone(cachedData), sha: null, isNew: true };
    }

    if (response.status === 401 || response.status === 403) {
      const msg = await parseErrorMessage(response);
      throw new Error(`GitHub access denied: ${msg}. Check your Fine-Grained PAT Contents permission.`);
    }

    if (!response.ok) {
      throw new Error(await parseErrorMessage(response));
    }

    const payload = await response.json();
    const rawText = decodeBase64ToUtf8(payload.content || "");
    const parsed = rawText.trim() ? JSON.parse(rawText) : createEmptyLedger(homeCurrency);
    cachedSha = payload.sha;
    cachedData = normalizeLedger(parsed, homeCurrency);

    return { data: structuredClone(cachedData), sha: cachedSha, isNew: false };
  }

  // Creates an orphan branch containing only `filePath` so expense saves never touch `main` or trigger Pages rebuilds.
  async function bootstrapOrphanBranch(jsonContent, commitMessage) {
    const baseRepoUrl = `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

    const blobRes = await apiRequest(`${baseRepoUrl}/git/blobs`, {
      method: "POST",
      body: JSON.stringify({ content: jsonContent, encoding: "utf-8" }),
    });
    if (!blobRes.ok) {
      throw new Error(`Failed creating data blob: ${await parseErrorMessage(blobRes)}`);
    }
    const blob = await blobRes.json();

    const treeRes = await apiRequest(`${baseRepoUrl}/git/trees`, {
      method: "POST",
      body: JSON.stringify({
        tree: [
          {
            path: filePath,
            mode: "100644",
            type: "blob",
            sha: blob.sha,
          },
        ],
      }),
    });
    if (!treeRes.ok) {
      throw new Error(`Failed creating data tree: ${await parseErrorMessage(treeRes)}`);
    }
    const tree = await treeRes.json();

    const commitRes = await apiRequest(`${baseRepoUrl}/git/commits`, {
      method: "POST",
      body: JSON.stringify({
        message: commitMessage,
        tree: tree.sha,
        parents: [],
      }),
    });
    if (!commitRes.ok) {
      throw new Error(`Failed creating initial data commit: ${await parseErrorMessage(commitRes)}`);
    }
    const commit = await commitRes.json();

    const refRes = await apiRequest(`${baseRepoUrl}/git/refs`, {
      method: "POST",
      body: JSON.stringify({
        ref: `refs/heads/${branch}`,
        sha: commit.sha,
      }),
    });

    if (refRes.status === 422) {
      // Branch was created concurrently by the other partner; caller will retry via normal PUT.
      return { conflict: true };
    }
    if (!refRes.ok) {
      throw new Error(`Failed creating '${branch}' branch: ${await parseErrorMessage(refRes)}`);
    }

    return { conflict: false, sha: blob.sha };
  }

  async function mutate(mutatorFn, commitMessage = "Update trip expenses") {
    for (let attempt = 1; attempt <= MAX_CONFLICT_RETRIES; attempt += 1) {
      if (!cachedData || attempt > 1) {
        await load();
      }

      const nextData = normalizeLedger(mutatorFn(structuredClone(cachedData)), homeCurrency);
      const serialized = `${JSON.stringify(nextData, null, 2)}\n`;

      const body = {
        message: commitMessage,
        content: encodeUtf8ToBase64(serialized),
        branch,
      };
      if (cachedSha) {
        body.sha = cachedSha;
      }

      const response = await apiRequest(contentsUrl, {
        method: "PUT",
        body: JSON.stringify(body),
      });

      if (response.ok) {
        const result = await response.json();
        cachedSha = result?.content?.sha || null;
        cachedData = nextData;
        return { data: structuredClone(cachedData), sha: cachedSha };
      }

      // Missing orphan branch on first write
      if (!cachedSha && (response.status === 404 || response.status === 422)) {
        const errMsg = await parseErrorMessage(response);
        if (/branch|not found|reference/i.test(errMsg)) {
          const boot = await bootstrapOrphanBranch(serialized, commitMessage);
          if (!boot.conflict) {
            cachedSha = boot.sha;
            cachedData = nextData;
            return { data: structuredClone(cachedData), sha: cachedSha };
          }
          continue;
        }
        if (response.status === 422) {
          // File was created concurrently while our cachedSha was null; retry with fresh SHA.
          continue;
        }
        throw new Error(errMsg);
      }

      // Optimistic concurrency conflict — re-fetch latest remote ledger and replay mutation.
      if (response.status === 409 || response.status === 422) {
        if (attempt < MAX_CONFLICT_RETRIES) {
          continue;
        }
        throw new Error("Could not save because both partners edited at the same time. Please refresh and try again.");
      }

      if (response.status === 401 || response.status === 403) {
        throw new Error(`GitHub write rejected: ${await parseErrorMessage(response)}`);
      }

      throw new Error(await parseErrorMessage(response));
    }

    throw new Error("Failed to save expenses after retries.");
  }

  return {
    mode: "github",
    load,
    mutate,
  };
}

export function createLocalDemoStorage(homeCurrency = "SGD", userIds = ["partnerA", "partnerB"]) {
  function seedSampleData() {
    const [idA, idB] = userIds;
    const today = new Date().toISOString().slice(0, 10);
    return {
      version: 1,
      homeCurrency,
      entries: [
        {
          id: `exp_${today.replace(/-/g, "")}_demo01`,
          type: "expense",
          title: "Ramen dinner (Demo)",
          date: today,
          amount: 4800,
          currency: "JPY",
          fxRate: 0.0088,
          amountHome: 42.24,
          paidBy: idA,
          splitMode: "even",
          splits: { [idA]: 2400, [idB]: 2400 },
          splitsHome: { [idA]: 21.12, [idB]: 21.12 },
          tags: ["Japan 2026"],
          notes: "Sample multi-currency expense",
          createdBy: idA,
          createdAt: new Date(Date.now() - 3600000).toISOString(),
          updatedAt: new Date(Date.now() - 3600000).toISOString(),
        },
        {
          id: `exp_${today.replace(/-/g, "")}_demo02`,
          type: "expense",
          title: "Airport Grab (Demo)",
          date: today,
          amount: 34,
          currency: homeCurrency,
          fxRate: 1,
          amountHome: 34,
          paidBy: idB,
          splitMode: "even",
          splits: { [idA]: 17, [idB]: 17 },
          splitsHome: { [idA]: 17, [idB]: 17 },
          notes: "",
          createdBy: idB,
          createdAt: new Date(Date.now() - 1800000).toISOString(),
          updatedAt: new Date(Date.now() - 1800000).toISOString(),
        },
      ],
    };
  }

  function readLocal() {
    try {
      const raw = localStorage.getItem(DEMO_STORAGE_KEY);
      if (!raw) {
        const seeded = seedSampleData();
        localStorage.setItem(DEMO_STORAGE_KEY, JSON.stringify(seeded));
        return seeded;
      }
      return normalizeLedger(JSON.parse(raw), homeCurrency);
    } catch {
      return createEmptyLedger(homeCurrency);
    }
  }

  return {
    mode: "demo",
    async load() {
      return { data: structuredClone(readLocal()), sha: "demo", isNew: false };
    },
    async mutate(mutatorFn) {
      const current = readLocal();
      const next = normalizeLedger(mutatorFn(structuredClone(current)), homeCurrency);
      localStorage.setItem(DEMO_STORAGE_KEY, JSON.stringify(next));
      return { data: structuredClone(next), sha: "demo" };
    },
  };
}
