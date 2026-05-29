const CDP_COMMAND_HINT = 'DOUYIN_CDP_URL=http://127.0.0.1:9222 npm run dashboard';

function check(id, label, state, detail) {
  return { id, label, state, detail };
}

function runtimeName(runtime) {
  if (runtime === 'cdp') return 'CDP';
  if (runtime === 'playwright') return 'Playwright';
  if (runtime === 'apple-events') return 'Apple Events';
  return runtime || 'Runtime';
}

function cookieCheck(runtime, cookieAuth) {
  const supported = runtime === 'playwright' || runtime === 'cdp';
  if (!supported) {
    return check('cookie-auth', 'Cookie 登录态', 'info', '当前 runtime 直接复用浏览器登录态，不使用 cookie 注入。');
  }
  if (cookieAuth?.error) {
    return check('cookie-auth', 'Cookie 登录态', 'fail', 'Cookie 文件存在但无法解析，请重新导入 cookie-manager 无损 JSON。');
  }
  if (cookieAuth?.configured) {
    return check(
      'cookie-auth',
      'Cookie 登录态',
      'pass',
      `已配置 ${cookieAuth.acceptedCount || 0}/${cookieAuth.cookieCount || 0} 个可用 cookie。`
    );
  }
  return check('cookie-auth', 'Cookie 登录态', 'warn', '未配置 Cookie；首次运行可能需要手动登录或验证。');
}

function verificationCheck(scanStatus) {
  const challenge = scanStatus?.authChallenge || null;
  if (scanStatus?.phase === 'waiting_for_verification' && challenge?.status === 'waiting') {
    const label = challenge.kind === 'login' ? '等待登录' : '等待验证码';
    return check('verification', label, 'fail', '请在采集浏览器中人工完成，完成后任务会继续。');
  }
  if (challenge?.status === 'resolved') {
    return check('verification', '验证状态', 'pass', '最近一次人工验证已经完成。');
  }
  if (challenge?.status === 'timeout') {
    return check('verification', '验证状态', 'fail', '最近一次等待人工验证超时。');
  }
  return check('verification', '验证状态', 'pass', '当前没有等待中的登录或验证码。');
}

function runtimeCheck(runtime) {
  if (runtime === 'cdp') {
    return check('runtime', '浏览器 Runtime', 'pass', '正在复用已开启远程调试的本机浏览器。');
  }
  if (runtime === 'playwright') {
    return check('runtime', '浏览器 Runtime', 'warn', '跨平台默认路径；新 profile 可能更容易触发人工验证。');
  }
  if (runtime === 'apple-events') {
    return check('runtime', '浏览器 Runtime', 'info', 'macOS 便捷路径；开源跨平台部署建议使用 CDP 或 Playwright。');
  }
  return check('runtime', '浏览器 Runtime', 'warn', 'Runtime 未识别，请检查 dashboard 启动参数。');
}

function privacyCheck() {
  return check('privacy-boundary', '安全边界', 'pass', '只做本地诊断，不自动识别、拖动或绕过验证码。');
}

function buildRuntimeHealth({ scanStatus = {}, cookieAuth = null, latestError = null } = {}) {
  const runtime = scanStatus.runtime || 'auto';
  const runtimeLabel = scanStatus.runtimeLabel || runtimeName(runtime);
  const auth = cookieAuth || scanStatus.cookieAuth || null;
  const isWaitingForVerification = scanStatus.phase === 'waiting_for_verification'
    && scanStatus.authChallenge?.status === 'waiting';
  const hasCookie = Boolean(auth?.configured && !auth?.error && (auth.acceptedCount || 0) > 0);
  const checks = [
    runtimeCheck(runtime),
    cookieCheck(runtime, auth),
    verificationCheck(scanStatus),
    latestError?.errorCode
      ? check('latest-error', '最近错误', 'warn', `${latestError.errorCode}: ${latestError.suggestion || '请查看 data/latest-error.json 的脱敏摘要。'}`)
      : check('latest-error', '最近错误', 'pass', '没有记录到最近采集错误。'),
    privacyCheck()
  ];

  if (isWaitingForVerification) {
    return {
      runtime,
      runtimeLabel,
      level: 'action',
      headline: '等待人工验证',
      recommendation: '请在采集浏览器中完成登录或验证码。若频繁出现，建议改用 CDP 复用已登录浏览器会话。',
      recommendedRuntime: 'cdp',
      checks,
      commandHint: CDP_COMMAND_HINT
    };
  }

  if (runtime === 'cdp') {
    return {
      runtime,
      runtimeLabel,
      level: 'ok',
      headline: 'CDP 是当前推荐路径',
      recommendation: '保持远程调试浏览器运行并处于已登录状态，dashboard 会复用这个真实会话采集。',
      recommendedRuntime: 'cdp',
      checks,
      commandHint: CDP_COMMAND_HINT
    };
  }

  if (runtime === 'playwright' && hasCookie) {
    return {
      runtime,
      runtimeLabel,
      level: 'warning',
      headline: 'Playwright 可用，CDP 更稳',
      recommendation: 'Cookie 已配置，可以继续使用。若刷新或新 profile 频繁触发验证码，建议切到 CDP 复用日常浏览器。',
      recommendedRuntime: 'cdp',
      checks,
      commandHint: CDP_COMMAND_HINT
    };
  }

  if (runtime === 'playwright') {
    return {
      runtime,
      runtimeLabel,
      level: 'action',
      headline: '需要登录态配置',
      recommendation: '导入 cookie-manager 无损 JSON，或在 Playwright profile 中手动登录。稳定运行优先考虑 CDP。',
      recommendedRuntime: 'cdp',
      checks,
      commandHint: CDP_COMMAND_HINT
    };
  }

  if (runtime === 'apple-events') {
    return {
      runtime,
      runtimeLabel,
      level: 'ok',
      headline: 'macOS 便捷路径可用',
      recommendation: '当前会复用已登录浏览器。作为通用开源部署，推荐记录 CDP 或 Playwright 配置。',
      recommendedRuntime: 'cdp',
      checks,
      commandHint: CDP_COMMAND_HINT
    };
  }

  return {
    runtime,
    runtimeLabel,
    level: 'warning',
    headline: 'Runtime 状态需要确认',
    recommendation: '检查 dashboard 启动参数；推荐使用 CDP 连接已登录浏览器。',
    recommendedRuntime: 'cdp',
    checks,
    commandHint: CDP_COMMAND_HINT
  };
}

export { CDP_COMMAND_HINT, buildRuntimeHealth };
