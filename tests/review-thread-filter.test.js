const assert = require("node:assert/strict");
const test = require("node:test");

test("collectResolvedCommentIdsFromReviewThreadsResponse extracts resolved IDs and pageInfo", async () => {
  const mod = await import("../src/review-thread-filter.mjs");
  const json = {
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
            nodes: [
              {
                isResolved: true,
                comments: { nodes: [{ databaseId: 11 }, { databaseId: 22 }] }
              },
              {
                isResolved: false,
                comments: { nodes: [{ databaseId: 33 }] }
              },
              {
                isResolved: true,
                comments: { nodes: [{ databaseId: null }, { databaseId: 44 }] }
              }
            ]
          }
        }
      }
    }
  };

  const result = mod.collectResolvedCommentIdsFromReviewThreadsResponse(json);
  assert.deepEqual([...result.resolvedIds].sort((a, b) => a - b), [11, 22, 44]);
  assert.equal(result.pageInfo.hasNextPage, true);
  assert.equal(result.pageInfo.endCursor, "cursor-1");
});

test("collectResolvedCommentIdsFromReviewThreadsResponse throws when threads are missing", async () => {
  const mod = await import("../src/review-thread-filter.mjs");
  assert.throws(
    () => mod.collectResolvedCommentIdsFromReviewThreadsResponse({ data: { repository: { pullRequest: {} } } }),
    /Could not load review thread resolution state/
  );
});

test("filterOutResolvedComments removes resolved IDs", async () => {
  const mod = await import("../src/review-thread-filter.mjs");
  const items = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];
  const filtered = mod.filterOutResolvedComments(items, new Set([2, 4]));
  assert.deepEqual(filtered.map((x) => x.id), [1, 3]);
});

test("buildThreadedReviewComments groups replies under parent comments", async () => {
  const mod = await import("../src/review-thread-filter.mjs");
  const flat = [
    { id: 10, body: "root 10", createdAt: "2026-02-15T01:00:00Z", inReplyToId: null },
    { id: 11, body: "reply A", createdAt: "2026-02-15T01:02:00Z", inReplyToId: 10, user: "u1" },
    { id: 12, body: "reply B", createdAt: "2026-02-15T01:01:00Z", inReplyToId: 10, user: "u2" },
    { id: 20, body: "root 20", createdAt: "2026-02-15T02:00:00Z", inReplyToId: null },
    { id: 30, body: "orphan", createdAt: "2026-02-15T03:00:00Z", inReplyToId: 999 }
  ];

  const threaded = mod.buildThreadedReviewComments(flat);
  assert.deepEqual(threaded.map((x) => x.id), [10, 20, 30]);
  assert.deepEqual(threaded[0].replies.map((x) => x.id), [12, 11]);
  assert.equal(threaded[1].replies.length, 0);
  assert.equal(threaded[2].replies.length, 0);
});
