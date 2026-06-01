#!/usr/bin/env node

// ============================================================================
// Follow Builders — Prepare Digest
// ============================================================================
// Gathers everything the LLM needs to produce a digest:
// - Fetches the central feeds (tweets + podcasts)
// - Fetches the latest prompts from GitHub
// - Reads the user's config (language, delivery method)
// - Outputs a single JSON blob to stdout
//
// The LLM's ONLY job is to read this JSON, remix the content, and output
// the digest text. Everything else is handled here deterministically.
//
// Usage: node prepare-digest.js
// Output: JSON to stdout
// ============================================================================

import { readFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// -- Constants ---------------------------------------------------------------

const USER_DIR = join(homedir(), '.follow-builders');
const CONFIG_PATH = join(USER_DIR, 'config.json');

const FEED_X_URL = 'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-x.json';
const FEED_PODCASTS_URL = 'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-podcasts.json';
const FEED_BLOGS_URL = 'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-blogs.json';

// Personal feeds hosted on user's fork
const FORK_BASE = 'https://raw.githubusercontent.com/xiaoellenwang/follow-builders/main';
const FEED_YOUTUBE_URL = `${FORK_BASE}/feed-youtube.json`;
const FEED_JOBS_URL = `${FORK_BASE}/feed-jobs.json`;
const FEED_DATA_INDUSTRY_URL = `${FORK_BASE}/feed-data-industry.json`;
const FEED_NEWSLETTERS_URL = `${FORK_BASE}/feed-newsletters.json`;

// How many top X builders to include in each digest
const TOP_X_COUNT = 3;

// 只保留这三个播客（中央 feed 里的其他播客过滤掉）
const TRACKED_PODCASTS = ["Lenny's Podcast", 'AI & I by Every', 'Training Data', "Lenny's Podcast (YouTube)"];

const PROMPTS_BASE = 'https://raw.githubusercontent.com/xiaoellenwang/follow-builders/main/prompts';
const PROMPT_FILES = [
  'summarize-podcast.md',
  'summarize-tweets.md',
  'summarize-blogs.md',
  'summarize-youtube.md',
  'summarize-jobs.md',
  'summarize-data-industry.md',
  'summarize-newsletter.md',
  'digest-intro.md',
  'translate.md'
];

// -- Fetch helpers -----------------------------------------------------------

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) return null;
  return res.json();
}

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) return null;
  return res.text();
}

// -- Main --------------------------------------------------------------------

async function main() {
  const errors = [];

  // 1. Read user config
  let config = {
    language: 'en',
    frequency: 'daily',
    delivery: { method: 'stdout' }
  };
  if (existsSync(CONFIG_PATH)) {
    try {
      config = JSON.parse(await readFile(CONFIG_PATH, 'utf-8'));
    } catch (err) {
      errors.push(`Could not read config: ${err.message}`);
    }
  }

  // 2. Fetch all feeds in parallel
  const [feedX, feedPodcasts, feedBlogs, feedYoutube, feedJobs, feedDataIndustry, feedNewsletters] = await Promise.all([
    fetchJSON(FEED_X_URL),
    fetchJSON(FEED_PODCASTS_URL),
    fetchJSON(FEED_BLOGS_URL),
    fetchJSON(FEED_YOUTUBE_URL),
    fetchJSON(FEED_JOBS_URL),
    fetchJSON(FEED_DATA_INDUSTRY_URL),
    fetchJSON(FEED_NEWSLETTERS_URL)
  ]);

  if (!feedX) errors.push('Could not fetch tweet feed');
  if (!feedPodcasts) errors.push('Could not fetch podcast feed');
  if (!feedBlogs) errors.push('Could not fetch blog feed');
  if (feedX?.errors?.length) {
    errors.push(...feedX.errors.map((error) => `Tweet feed problem: ${error}`));
  }
  if (feedPodcasts?.errors?.length) {
    errors.push(...feedPodcasts.errors.map((error) => `Podcast feed problem: ${error}`));
  }
  if (feedBlogs?.errors?.length) {
    errors.push(...feedBlogs.errors.map((error) => `Blog feed problem: ${error}`));
  }

  // Pick top N builders by tweet count (most active = most to summarize)
  const filteredX = (feedX?.x || [])
    .filter(builder => (builder.tweets?.length || 0) > 0)
    .sort((a, b) => (b.tweets?.length || 0) - (a.tweets?.length || 0))
    .slice(0, TOP_X_COUNT);

  // 3. Load prompts with priority: user custom > remote (GitHub) > local default
  //
  // If the user has a custom prompt at ~/.follow-builders/prompts/<file>,
  // use that (they personalized it — don't overwrite with remote updates).
  // Otherwise, fetch the latest from GitHub so they get central improvements.
  // If GitHub is unreachable, fall back to the local copy shipped with the skill.
  const prompts = {};
  const scriptDir = decodeURIComponent(new URL('.', import.meta.url).pathname);
  const localPromptsDir = join(scriptDir, '..', 'prompts');
  const userPromptsDir = join(USER_DIR, 'prompts');

  for (const filename of PROMPT_FILES) {
    const key = filename.replace('.md', '').replace(/-/g, '_');
    const userPath = join(userPromptsDir, filename);
    const localPath = join(localPromptsDir, filename);

    // Priority 1: user's custom prompt (they personalized it)
    if (existsSync(userPath)) {
      prompts[key] = await readFile(userPath, 'utf-8');
      continue;
    }

    // Priority 2: latest from GitHub (central updates)
    const remote = await fetchText(`${PROMPTS_BASE}/${filename}`);
    if (remote) {
      prompts[key] = remote;
      continue;
    }

    // Priority 3: local copy shipped with the skill
    if (existsSync(localPath)) {
      prompts[key] = await readFile(localPath, 'utf-8');
    } else {
      errors.push(`Could not load prompt: ${filename}`);
    }
  }

  // 4. Build the output — everything the LLM needs in one blob
  const output = {
    status: 'ok',
    generatedAt: new Date().toISOString(),

    // User preferences
    config: {
      language: config.language || 'en',
      frequency: config.frequency || 'daily',
      delivery: config.delivery || { method: 'stdout' }
    },

    // Content to remix — 只保留选定的三个播客
    podcasts: (feedPodcasts?.podcasts || []).filter(p =>
      TRACKED_PODCASTS.some(name => p.name?.includes(name) || name.includes(p.name))
    ),
    x: filteredX,
    blogs: feedBlogs?.blogs || [],
    youtube: feedYoutube?.videos || [],
    jobs: feedJobs?.jobs || [],
    dataIndustry: feedDataIndustry?.articles || [],
    newsletters: feedNewsletters?.newsletters || [],

    // Stats for the LLM to reference
    stats: {
      podcastEpisodes: feedPodcasts?.podcasts?.length || 0,
      xBuilders: filteredX.length,
      totalTweets: filteredX.reduce((sum, a) => sum + (a.tweets?.length || 0), 0),
      blogPosts: feedBlogs?.blogs?.length || 0,
      youtubeVideos: feedYoutube?.videos?.length || 0,
      jobListings: feedJobs?.jobs?.length || 0,
      dataArticles: feedDataIndustry?.articles?.length || 0,
      newsletters: feedNewsletters?.newsletters?.length || 0,
      feedGeneratedAt: feedX?.generatedAt || feedPodcasts?.generatedAt || null
    },

    // Prompts — the LLM reads these and follows the instructions
    prompts,

    // Non-fatal errors
    errors: errors.length > 0 ? errors : undefined
  };

  console.log(JSON.stringify(output, null, 2));
}

main().catch(err => {
  console.error(JSON.stringify({
    status: 'error',
    message: err.message
  }));
  process.exit(1);
});
