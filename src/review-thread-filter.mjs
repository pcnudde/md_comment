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

export function buildThreadedReviewComments(flatComments) {
  if (!Array.isArray(flatComments) || flatComments.length === 0) {
    return [];
  }

  const byId = new Map();
  const clones = flatComments.map((comment) => {
    const clone = {
      ...comment,
      replies: []
    };
    byId.set(Number(clone.id || 0), clone);
    return clone;
  });

  const roots = [];
  for (const comment of clones) {
    const parentId = Number(comment.inReplyToId || comment.in_reply_to_id || 0);
    if (parentId > 0 && byId.has(parentId)) {
      const parent = byId.get(parentId);
      parent.replies.push({
        id: comment.id,
        body: comment.body || "",
        user: comment.user || "unknown",
        createdAt: comment.createdAt || "",
        updatedAt: comment.updatedAt || "",
        htmlUrl: comment.htmlUrl || "",
        inReplyToId: comment.inReplyToId || parentId
      });
      continue;
    }

    roots.push(comment);
  }

  for (const root of roots) {
    if (!Array.isArray(root.replies) || root.replies.length <= 1) {
      continue;
    }

    root.replies.sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
  }

  return roots;
}
