#!/usr/bin/env node
// ============================================================================
// update-feeds.js — 每日自动更新个人 feed 文件
// 运行：node scripts/update-feeds.js
// 更新：feed-youtube.json / feed-jobs.json / feed-data-industry.json
// ============================================================================

import { writeFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parseStringPromise } from 'xml2js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ── YouTube 频道配置 ──────────────────────────────────────────────────────────
const YOUTUBE_CHANNELS = [
  {
    name: 'Andrej Karpathy',
    channelId: 'UCXUPKJO5MZQMU011usP3tXw',
    handle: 'AndrejKarpathy'
  },
  {
    name: "Lenny's Podcast",
    channelId: 'UC6t1O76G0jYXOAoYCm153dA',
    handle: 'LennysPodcast'
  }
];

// ── 数据行业新闻 RSS 源 ────────────────────────────────────────────────────────
const DATA_INDUSTRY_RSS = [
  // AI 综合
  { name: 'VentureBeat AI', url: 'https://venturebeat.com/category/ai/feed/' },
  { name: 'Import AI', url: 'https://jack-clark.net/feed/' },
  { name: 'MIT Technology Review', url: 'https://www.technologyreview.com/feed/' },
  // 数据中心 & AI 基础设施（重点加强）
  { name: 'Data Center Knowledge', url: 'https://www.datacenterknowledge.com/rss.xml' },
  { name: 'Data Center Dynamics', url: 'https://www.datacenterdynamics.com/en/rss/' },
  { name: 'The Next Platform', url: 'https://www.nextplatform.com/feed/' },
  { name: 'Ars Technica Tech', url: 'https://feeds.arstechnica.com/arstechnica/technology-lab' },
  { name: 'The Register AI', url: 'https://www.theregister.com/offbeat/bofh/headlines.atom' },
  // 数据工程
  { name: 'DataEngineeringWeekly', url: 'https://www.dataengineeringweekly.com/feed' },
];

// ── Newsletter 源配置 ─────────────────────────────────────────────────────────
const NEWSLETTER_SOURCES = [
  {
    name: 'The AI Valley',
    archiveUrl: 'https://www.theaivalley.com/',
    baseUrl: 'https://www.theaivalley.com',
    // Beehiiv 文章链接格式: /p/article-slug
    articlePattern: /href="(\/p\/[a-z0-9-]+)"/g,
    // 抓最新 2 篇
    limit: 2
  },
  {
    name: 'Every',
    archiveUrl: 'https://every.to/newsletter',
    baseUrl: 'https://every.to',
    // Every 文章链接格式: /[publication]/p/article-slug
    articlePattern: /href="(\/[a-z-]+\/p\/[a-z0-9-]+)"/g,
    limit: 2
  }
];

// ── 工具函数 ──────────────────────────────────────────────────────────────────
async function fetchText(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    return res.text();
  } catch {
    return null;
  }
}

async function fetchJSON(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

// ── YouTube：通过公共 RSS 获取最新视频 ────────────────────────────────────────
async function fetchYoutubeVideos() {
  const videos = [];
  for (const channel of YOUTUBE_CHANNELS) {
    const rssUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channel.channelId}`;
    const xml = await fetchText(rssUrl);
    if (!xml) {
      console.error(`[YouTube] 无法获取 ${channel.name} 的 RSS`);
      continue;
    }
    try {
      const parsed = await parseStringPromise(xml);
      const entries = parsed?.feed?.entry || [];
      const cutoff = daysAgo(7); // 只取近 7 天

      for (const entry of entries) {
        const published = new Date(entry.published?.[0] || 0);
        if (published < cutoff) continue;

        const videoId = entry['yt:videoId']?.[0];
        if (!videoId) continue;

        videos.push({
          channel: channel.name,
          title: entry.title?.[0] || '',
          url: `https://www.youtube.com/watch?v=${videoId}`,
          published: published.toISOString(),
          description: entry['media:group']?.[0]?.['media:description']?.[0]?.slice(0, 300) || ''
        });
      }
    } catch (e) {
      console.error(`[YouTube] 解析失败 ${channel.name}: ${e.message}`);
    }
  }
  return videos;
}

// ── 新加坡 AI 岗位：MyCareersFuture API ───────────────────────────────────────
async function fetchSgJobs() {
  const keywords = ['artificial intelligence', 'machine learning', 'data scientist', 'AI engineer', 'MLOps', 'LLM'];
  const jobs = [];
  const seen = new Set();

  // 只保留真正 AI/数据相关的职位标题（全词匹配，避免 "retail" 含 "ai" 的误判）
  const AI_TITLE_PATTERN = /\b(AI|A\.I\.|artificial intelligence|machine learning|ML|LLM|data scien|data engineer|MLOps|NLP|deep learning|computer vision|gen[ae]rative|RPA|quant researcher)\b/i;

  // 排除明显无关的公司或职位类别
  const EXCLUDE_PATTERN = /property|leasing|concierge|retail manager|accounts|building manager|centre manager|customer service officer/i;

  for (const kw of keywords) {
    const url = `https://api.mycareersfuture.gov.sg/v2/jobs?search=${encodeURIComponent(kw)}&sortBy=new_posting_date&limit=10`;
    const data = await fetchJSON(url);
    if (!data?.results) continue;

    for (const job of data.results) {
      if (seen.has(job.uuid)) continue;
      seen.add(job.uuid);

      const title = job.title || '';
      // 必须符合 AI 相关标题，且不在排除名单
      if (!AI_TITLE_PATTERN.test(title)) continue;
      if (EXCLUDE_PATTERN.test(title)) continue;

      const posted = new Date(job.metadata?.createdAt || 0);
      if (posted < daysAgo(3)) continue;

      jobs.push({
        title,
        company: job.postedCompany?.name || '',
        salary: job.salary
          ? `S$${job.salary.minimum?.toLocaleString()} – S$${job.salary.maximum?.toLocaleString()}`
          : null,
        type: job.employmentTypes?.[0]?.employmentType || 'Full Time',
        skills: (job.skills || []).slice(0, 3).map(s => s.skill),
        url: `https://www.mycareersfuture.gov.sg/job/${job.uuid}`,
        posted: posted.toISOString()
      });
    }
  }

  // 去重后按发布时间倒序，最多保留 15 条
  return jobs
    .sort((a, b) => new Date(b.posted) - new Date(a.posted))
    .slice(0, 15);
}

// ── 数据行业动态：RSS 抓取 ─────────────────────────────────────────────────────
async function fetchDataIndustryNews() {
  const articles = [];
  const cutoff = daysAgo(3);

  for (const source of DATA_INDUSTRY_RSS) {
    const xml = await fetchText(source.url);
    if (!xml) {
      console.error(`[News] 无法获取 ${source.name}`);
      continue;
    }
    try {
      const parsed = await parseStringPromise(xml);
      const items = parsed?.rss?.channel?.[0]?.item || parsed?.feed?.entry || [];

      for (const item of items.slice(0, 5)) {
        const pubDate = new Date(
          item.pubDate?.[0] || item.published?.[0] || item.updated?.[0] || 0
        );
        if (pubDate < cutoff) continue;

        const title = item.title?.[0]?._ || item.title?.[0] || '';
        const link = item.link?.[0]?.$ ? item.link[0].$.href : (item.link?.[0] || '');
        const desc = item.description?.[0] || item['content:encoded']?.[0] || item.summary?.[0] || '';
        // 去掉 HTML 标签，截取前 300 字
        const cleanDesc = desc.replace(/<[^>]+>/g, '').slice(0, 300);

        if (!title || !link) continue;

        articles.push({
          source: source.name,
          title,
          url: link,
          description: cleanDesc,
          published: pubDate.toISOString()
        });
      }
    } catch (e) {
      console.error(`[News] 解析失败 ${source.name}: ${e.message}`);
    }
  }

  return articles
    .sort((a, b) => new Date(b.published) - new Date(a.published))
    .slice(0, 20);
}

// ── 主流程 ────────────────────────────────────────────────────────────────────
async function main() {
  console.log('🔄 开始更新 feeds...');
  const now = new Date().toISOString();

  const [videos, jobs, articles] = await Promise.all([
    fetchYoutubeVideos(),
    fetchSgJobs(),
    fetchDataIndustryNews()
  ]);

  console.log(`✅ YouTube: ${videos.length} 个视频`);
  console.log(`✅ SG 职位: ${jobs.length} 条`);
  console.log(`✅ 行业动态: ${articles.length} 条`);

  await writeFile(
    join(ROOT, 'feed-youtube.json'),
    JSON.stringify({ generatedAt: now, videos }, null, 2)
  );

  await writeFile(
    join(ROOT, 'feed-jobs.json'),
    JSON.stringify({ generatedAt: now, jobs }, null, 2)
  );

  await writeFile(
    join(ROOT, 'feed-data-industry.json'),
    JSON.stringify({ generatedAt: now, articles }, null, 2)
  );

  console.log('✅ 所有 feed 文件已更新');
}

main().catch(err => {
  console.error('❌ 更新失败:', err.message);
  process.exit(1);
});
