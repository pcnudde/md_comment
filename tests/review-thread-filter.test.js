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
