export function collectResolvedCommentIdsFromReviewThreadsResponse(json) {
  const threads =
    json &&
    json.data &&
    json.data.repository &&
    json.data.repository.pullRequest &&
    json.data.repository.pullRequest.reviewThreads;

  if (!threads || !Array.isArray(threads.nodes)) {
    throw new Error("Could not load review thread resolution state from GitHub GraphQL.");
  }

  const resolvedIds = new Set();
  for (const thread of threads.nodes) {
    if (!thread || !thread.isResolved) {
      continue;
    }

    const nodes = thread.comments && Array.isArray(thread.comments.nodes) ? thread.comments.nodes : [];
    for (const comment of nodes) {
      const id = Number(comment && comment.databaseId ? comment.databaseId : 0);
      if (id > 0) {
        resolvedIds.add(id);
      }
    }
  }

  return {
    resolvedIds,
    pageInfo: threads.pageInfo || {}
  };
}

export function filterOutResolvedComments(items, resolvedIds) {
  if (!Array.isArray(items) || items.length === 0) {
    return [];
  }

  const ids = resolvedIds instanceof Set ? resolvedIds : new Set();
  return items.filter((item) => !ids.has(Number(item && item.id ? item.id : 0)));
}
