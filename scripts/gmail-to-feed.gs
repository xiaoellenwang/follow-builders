// ============================================================================
// Gmail Newsletter → GitHub Feed
// 部署在 Google Apps Script，每小时自动运行
//
// 设置步骤：
// 1. 打开 https://script.google.com
// 2. 新建项目，把这段代码粘贴进去
// 3. 填写下方 CONFIG 里的 GITHUB_TOKEN 和 GITHUB_REPO
// 4. 运行一次 setup() 函数授权 Gmail 权限
// 5. 设置触发器：每小时运行 checkNewsletters()
// ============================================================================

const CONFIG = {
  GITHUB_TOKEN: 'YOUR_GITHUB_TOKEN_HERE', // 粘贴你的 GitHub Token（不要提交到 git）
  GITHUB_REPO: 'xiaoellenwang/follow-builders',
  FEED_PATH: 'feed-newsletters.json',

  // 要监控的 newsletter 发件人
  SENDERS: [
    { name: 'The AI Valley', email: 'barsee@theaivalley.com' },
    { name: 'Every',         email: 'hello@every.to' }
  ],

  // Gmail 标签（处理过的邮件会打上这个标签）
  PROCESSED_LABEL: 'newsletter-processed',

  // 保留最近几期（避免 feed 无限增长）
  MAX_ISSUES: 6
};

// ── 主函数：检查 Gmail 新邮件 ─────────────────────────────────────────────────
function checkNewsletters() {
  const label = getOrCreateLabel(CONFIG.PROCESSED_LABEL);
  const newItems = [];

  for (const source of CONFIG.SENDERS) {
    // 搜索未处理的邮件
    const query = `from:${source.email} -label:${CONFIG.PROCESSED_LABEL} newer_than:2d`;
    const threads = GmailApp.search(query, 0, 5);

    for (const thread of threads) {
      const message = thread.getMessages()[0];
      const subject = message.getSubject();
      const date = message.getDate();
      const body = extractTextFromEmail(message);

      if (body.length < 100) continue; // 跳过太短的邮件（可能是广告）

      newItems.push({
        source: source.name,
        title: subject,
        receivedAt: date.toISOString(),
        content: body.slice(0, 8000), // 限制长度，控制 token 消耗
        wordCount: body.split(' ').length
      });

      // 打标签，避免重复处理
      thread.addLabel(label);
    }
  }

  if (newItems.length === 0) {
    Logger.log('没有新 newsletter');
    return;
  }

  Logger.log(`找到 ${newItems.length} 篇新 newsletter，准备更新 GitHub...`);
  updateGitHubFeed(newItems);
}

// ── 提取邮件纯文本 ────────────────────────────────────────────────────────────
function extractTextFromEmail(message) {
  // 优先用纯文本版本
  let body = message.getPlainBody();

  if (!body || body.length < 200) {
    // 降级用 HTML 版本，去掉标签
    body = message.getBody()
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/\s{3,}/g, '\n\n')
      .trim();
  }

  // 去掉 unsubscribe 等页脚内容
  const cutoffs = [
    'unsubscribe', 'Unsubscribe', '取消订阅',
    'You received this', 'You are receiving',
    'Manage preferences', 'View in browser'
  ];
  for (const cutoff of cutoffs) {
    const idx = body.indexOf(cutoff);
    if (idx > 500) { // 确保不是误切
      body = body.slice(0, idx).trim();
      break;
    }
  }

  return body.trim();
}

// ── 更新 GitHub feed-newsletters.json ────────────────────────────────────────
function updateGitHubFeed(newItems) {
  const apiUrl = `https://api.github.com/repos/${CONFIG.GITHUB_REPO}/contents/${CONFIG.FEED_PATH}`;
  const headers = {
    'Authorization': `token ${CONFIG.GITHUB_TOKEN}`,
    'Accept': 'application/vnd.github.v3+json',
    'Content-Type': 'application/json'
  };

  // 先获取现有文件（需要 SHA 才能更新）
  let currentNewsletters = [];
  let fileSha = null;

  try {
    const getRes = UrlFetchApp.fetch(apiUrl, { headers, muteHttpExceptions: true });
    if (getRes.getResponseCode() === 200) {
      const fileData = JSON.parse(getRes.getContentText());
      fileSha = fileData.sha;
      const content = Utilities.newBlob(
        Utilities.base64Decode(fileData.content.replace(/\n/g, ''))
      ).getDataAsString();
      currentNewsletters = JSON.parse(content).newsletters || [];
    }
  } catch (e) {
    Logger.log('获取现有 feed 失败，将创建新文件: ' + e.message);
  }

  // 合并新旧内容，最新的在前，最多保留 MAX_ISSUES 条
  const merged = [...newItems, ...currentNewsletters]
    .slice(0, CONFIG.MAX_ISSUES);

  const newContent = JSON.stringify({
    generatedAt: new Date().toISOString(),
    newsletters: merged
  }, null, 2);

  // 推送到 GitHub
  const payload = {
    message: `chore: newsletter update ${new Date().toISOString().slice(0, 10)}`,
    content: Utilities.base64Encode(newContent, Utilities.Charset.UTF_8),
    ...(fileSha && { sha: fileSha })
  };

  const putRes = UrlFetchApp.fetch(apiUrl, {
    method: 'PUT',
    headers,
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  if (putRes.getResponseCode() === 200 || putRes.getResponseCode() === 201) {
    Logger.log(`✅ 成功推送 ${newItems.length} 篇 newsletter 到 GitHub`);
  } else {
    Logger.log('❌ 推送失败: ' + putRes.getContentText());
  }
}

// ── 工具：获取或创建 Gmail 标签 ───────────────────────────────────────────────
function getOrCreateLabel(name) {
  let label = GmailApp.getUserLabelByName(name);
  if (!label) {
    label = GmailApp.createLabel(name);
    Logger.log(`创建标签: ${name}`);
  }
  return label;
}

// ── 首次运行：测试授权 ────────────────────────────────────────────────────────
function setup() {
  Logger.log('Gmail 权限测试...');
  const threads = GmailApp.search('in:inbox', 0, 1);
  Logger.log(`✅ 授权成功，收件箱有 ${threads.length} 个邮件线程`);
  Logger.log('请接着设置触发器：左侧菜单 → 触发器 → 添加触发器 → checkNewsletters → 每小时');
}
