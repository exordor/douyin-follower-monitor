import { execFile as defaultExecFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(defaultExecFile);

function parseNotifyConfig({ notify = process.env.DOUYIN_NOTIFY || 'none', env = process.env } = {}) {
  const mode = String(notify || 'none').trim().toLowerCase();
  if (!['none', 'macos', 'webhook', 'bark'].includes(mode)) {
    throw new Error('--notify must be one of: none, macos, webhook, bark');
  }
  return {
    mode,
    webhookUrl: env.DOUYIN_NOTIFY_URL || '',
    barkUrl: env.DOUYIN_BARK_URL || env.BARK_URL || ''
  };
}

function buildNotificationPayload({ options = {}, followers = [], change = {}, status = 'completed' } = {}) {
  return {
    status,
    profileFollowerCount: options.profileStats?.followers ?? null,
    enumerableCount: followers.length,
    hiddenOrUnavailableCount: change.hiddenOrUnavailableCount ?? null,
    newCount: change.newCount ?? change.addedCount ?? 0,
    suspectedRemovedCount: change.suspectedRemovedCount ?? 0,
    removedCount: change.removedCount ?? 0,
    mutualUnfollowedYouCount: change.mutualUnfollowedYouCount ?? 0,
    renamedCount: change.renamedCount ?? 0,
    reappearedCount: change.reappearedCount ?? 0
  };
}

function notificationTitle(payload) {
  return payload.status === 'completed' ? '抖音粉丝采集完成' : '抖音粉丝采集失败';
}

function notificationMessage(payload) {
  const mutualUnfollow = payload.mutualUnfollowedYouCount > 0
    ? `，互关后取关我 ${payload.mutualUnfollowedYouCount}`
    : '';
  return `新增 ${payload.newCount}，疑似 ${payload.suspectedRemovedCount}，确认 ${payload.removedCount}${mutualUnfollow}，可枚举 ${payload.enumerableCount}`;
}

async function sendMacNotification(payload, { execFile = execFileAsync, platform = process.platform } = {}) {
  if (platform !== 'darwin') return { ok: false, skipped: true, reason: 'macos-only' };
  const script = `display notification ${JSON.stringify(notificationMessage(payload))} with title ${JSON.stringify(notificationTitle(payload))}`;
  await execFile('osascript', ['-e', script]);
  return { ok: true, channel: 'macos' };
}

async function sendWebhookNotification(payload, url, { fetchImpl = fetch } = {}) {
  if (!url) return { ok: false, skipped: true, reason: 'missing-url' };
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!response.ok) throw new Error(`Webhook notification failed: ${response.status}`);
  return { ok: true, channel: 'webhook' };
}

async function sendBarkNotification(payload, url, { fetchImpl = fetch } = {}) {
  if (!url) return { ok: false, skipped: true, reason: 'missing-url' };
  const target = new URL(url);
  target.searchParams.set('title', notificationTitle(payload));
  target.searchParams.set('body', notificationMessage(payload));
  target.searchParams.set('group', 'Douyin Follower Monitor');
  const response = await fetchImpl(target);
  if (!response.ok) throw new Error(`Bark notification failed: ${response.status}`);
  return { ok: true, channel: 'bark' };
}

async function sendNotification(payload, config = {}, deps = {}) {
  const parsed = parseNotifyConfig(config);
  if (parsed.mode === 'none') return { ok: true, skipped: true, reason: 'disabled' };
  if (parsed.mode === 'macos') return sendMacNotification(payload, deps);
  if (parsed.mode === 'webhook') return sendWebhookNotification(payload, parsed.webhookUrl, deps);
  if (parsed.mode === 'bark') return sendBarkNotification(payload, parsed.barkUrl, deps);
  return { ok: false, skipped: true, reason: 'unsupported' };
}

export {
  buildNotificationPayload,
  notificationMessage,
  notificationTitle,
  parseNotifyConfig,
  sendNotification
};
