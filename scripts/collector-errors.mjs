const ERROR_PATTERNS = [
  ['captcha_required', /验证码|captcha|verify|拼图|等待人工登录\/验证码超时/i],
  ['not_logged_in', /扫码登录|验证码登录|密码登录|登录用户 uid\/secUid|未登录|登录后可/i],
  ['rate_limited_or_risk_control', /risk|风控|rate|too many|blocked|频繁|稍后再试/i],
  ['douyin_api_unavailable', /follower API module is not available|粉丝接口|Douyin follower API/i],
  ['douyin_api_shape_changed', /webpack runtime is not available|webpack|返回异常|statusCode|shape/i],
  ['profile_count_unavailable', /读取主页计数失败|profile stats|主页计数/i],
  ['runtime_unavailable', /requires --cdp-url|requires --browser-app|browser runtime|Cannot find module|executable doesn't exist|Target page/i]
];

function classifyCollectorError(error) {
  const message = String(error?.stack || error?.message || error || '');
  for (const [code, pattern] of ERROR_PATTERNS) {
    if (pattern.test(message)) return code;
  }
  return 'unknown';
}

function publicErrorMessage(error) {
  return String(error?.message || error || '').split('\n')[0].slice(0, 500);
}

function errorSuggestion(code) {
  const suggestions = {
    captcha_required: '请在采集浏览器中完成人工验证码；如果频繁出现，优先改用 CDP 复用已登录浏览器。',
    not_logged_in: '请确认 runtime/profile 已登录抖音，并打开自己的个人主页。',
    runtime_unavailable: '请检查 runtime 参数、Playwright 浏览器安装或 CDP 连接地址。',
    douyin_api_unavailable: '抖音页面接口模块不可用，可能是页面未加载完成或平台前端结构变化。',
    douyin_api_shape_changed: '抖音页面结构可能变化，请带匿名 debug bundle 提 issue。',
    profile_count_unavailable: '主页粉丝计数读取失败，通常不影响列表采集，可重试或检查页面是否为个人主页。',
    rate_limited_or_risk_control: '可能触发平台风控，请降低频率，使用真实浏览器会话并人工处理验证。',
    unknown: '请查看日志尾部；如无法判断，生成匿名调试包后提 issue。'
  };
  return suggestions[code] || suggestions.unknown;
}

export { classifyCollectorError, errorSuggestion, publicErrorMessage };
