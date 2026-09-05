const RELATIONSHIP_STATUSES = new Set(['unknown', 'mutual', 'follower_only']);

function relationshipFromApiUser(user = {}) {
  const value = user.followStatus ?? user.follow_status;
  if (value === 2) return 'mutual';
  if (value === 0) return 'follower_only';
  return 'unknown';
}

function normalizeRelationshipStatus(value) {
  return RELATIONSHIP_STATUSES.has(value) ? value : 'unknown';
}

export {
  normalizeRelationshipStatus,
  relationshipFromApiUser
};
