/* eslint-disable no-console */
const { Client } = require('@notionhq/client');
const fs = require('fs');
const path = require('path');
const slugify = require('slugify');

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const databaseId = process.env.NOTION_DATABASE_ID;

// === あなたのDBに合わせてここを調整 ===
const PROP_TITLE = 'タイトル'; // Title型（例: 'タイトル' or 'Name'）
const PROP_DATE  = '日付';     // Date型
const ONLY_THREE_LINE = true;  // 「3行日記」に絞るならtrue、全件ならfalse
// =====================================

const OUT_DIR = path.join(process.cwd(), 'diary');
const ALL_MD_PATH = path.join(OUT_DIR, '_all.md');

function ensureDir(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }
function plainText(rich = []) { return rich.map((r) => r.plain_text || '').join(''); }

function blockToMarkdown(block) {
  const { type } = block;
  const b = block[type];
  const text = (rt = []) => plainText(rt);

  switch (type) {
    case 'heading_1': return `# ${text(b.rich_text)}\n\n`;
    case 'heading_2': return `## ${text(b.rich_text)}\n\n`;
    case 'heading_3': return `### ${text(b.rich_text)}\n\n`;
    case 'paragraph': return `${text(b.rich_text)}\n\n`;
    case 'bulleted_list_item': return `- ${text(b.rich_text)}\n`;
    case 'numbered_list_item': return `1. ${text(b.rich_text)}\n`;
    case 'to_do': return `- [${b.checked ? 'x' : ' '}] ${text(b.rich_text)}\n`;
    case 'quote': return `> ${text(b.rich_text)}\n\n`;
    case 'callout': return `> 💡 ${text(b.rich_text)}\n\n`;
    case 'divider': return `\n---\n\n`;
    case 'code': {
      const lang = b.language || '';
      const code = (b.rich_text || []).map(r => r.plain_text).join('');
      return `\n\`\`\`${lang}\n${code}\n\`\`\`\n\n`;
    }
    case 'image': {
      const url = b.type === 'external' ? b.external.url : b.file?.url;
      const cap = plainText(b.caption || []);
      return `![${cap || 'image'}](${url})\n\n`;
    }
    case 'toggle': return `<details><summary>${text(b.rich_text)}</summary>\n\n</details>\n\n`;
    default:
      return `<!-- unsupported block: ${type} -->\n`;
  }
}

async function listAllPages(database_id, filter) {
  const pages = [];
  let cursor;
  do {
    const resp = await notion.databases.query({
      database_id,
      start_cursor: cursor,
      page_size: 100,
      filter: filter || undefined,
      // 並び順は後で安全に並べ替えるのでここは任意
    });
    pages.push(...resp.results);
    cursor = resp.has_more ? resp.next_cursor : undefined;
  } while (cursor);
  return pages;
}

async function listAllChildren(block_id) {
  const blocks = [];
  let cursor;
  do {
    const resp = await notion.blocks.children.list({
      block_id,
      start_cursor: cursor,
      page_size: 100,
    });
    blocks.push(...resp.results);
    cursor = resp.has_more ? resp.next_cursor : undefined;
  } while (cursor);

  const expanded = [];
  for (const b of blocks) {
    expanded.push(b);
    if (b.has_children) {
      const kids = await listAllChildren(b.id);
      expanded.push(...kids);
    }
  }
  return expanded;
}

function getTitle(page) {
  const t = page.properties?.[PROP_TITLE]?.title || [];
  return plainText(t) || 'untitled';
}
function getDate(page) {
  const d = page.properties?.[PROP_DATE]?.date?.start;
  return d ? d.replace(/:/g, '-') : 'unknown';
}
function fileNameFrom(dateStr, title) {
  const slug = slugify(title, { lower: true, strict: true }) || 'note';
  return `${dateStr}_${slug}.md`;
}

// 長文がDBプロパティにある場合のフォールバック
function extractRichTextPropertyMarkdown(page) {
  const candidateProps = ['本文', '内容', 'テキスト', 'Body', 'Content'];
  for (const key of candidateProps) {
    const prop = page.properties?.[key];
    if (prop?.type === 'rich_text' && prop.rich_text?.length) {
      return plainText(prop.rich_text) + '\n\n';
    }
  }
  return '';
}

async function syncDiary() {
  if (!process.env.NOTION_TOKEN || !process.env.NOTION_DATABASE_ID) {
    throw new Error('NOTION_TOKEN / NOTION_DATABASE_ID が未設定です');
  }
  ensureDir(OUT_DIR);

  const filter = ONLY_THREE_LINE
    ? { property: PROP_TITLE, title: { contains: '3行日記' } }
    : undefined;

  console.log('📡 Query database...');
  let pages = await listAllPages(databaseId, filter);

  // 日付昇順（古い→新しい）で並べ替え（まとめファイルの読みやすさ重視）
  pages.sort((a, b) => {
    const ad = a.properties?.[PROP_DATE]?.date?.start || '';
    const bd = b.properties?.[PROP_DATE]?.date?.start || '';
    return ad.localeCompare(bd);
  });

  // まとめファイル用の一時バッファ
  const combinedParts = [];
  combinedParts.push(`# 3行日記（全件まとめ）\n\n`);
  combinedParts.push(`> 自動生成日時: ${new Date().toISOString()}\n\n`);
  combinedParts.push(`---\n\n`);
  combinedParts.push(`## 目次\n\n`);

  // 目次（内部リンク）を先に作る
  for (const page of pages) {
    const title = getTitle(page);
    const dateStr = getDate(page);
    const anchor = slugify(`${dateStr}-${title}`, { lower: true, strict: true }) || 'entry';
    combinedParts.push(`- [${dateStr} ${title}](#${anchor})\n`);
  }
  combinedParts.push(`\n---\n\n`);

  // 各ページを個別MD + まとめMDへ
  for (const page of pages) {
    const title = getTitle(page);
    const dateStr = getDate(page);
    const fname = fileNameFrom(dateStr, title);
    const fpath = path.join(OUT_DIR, fname);

    // 本文（ページブロック）
    let mdBody = '';
    const blocks = await listAllChildren(page.id);
    if (blocks.length) {
      for (const b of blocks) mdBody += blockToMarkdown(b);
    } else {
      const fallback = extractRichTextPropertyMarkdown(page);
      mdBody += fallback || '_（本文なし）_\n';
    }

    // 個別ファイル
    const perFileMd = `# ${title}\n\n- Date: ${dateStr}\n\n${mdBody}`;
    fs.writeFileSync(fpath, perFileMd, 'utf8');
    console.log(`📝 wrote: ${path.relative(process.cwd(), fpath)}`);

    // まとめファイル（H2 見出し＋アンカー）
    const anchor = slugify(`${dateStr}-${title}`, { lower: true, strict: true }) || 'entry';
    combinedParts.push(`\n<a id="${anchor}"></a>\n\n`);
    combinedParts.push(`## ${dateStr} ${title}\n\n`);
    combinedParts.push(`${mdBody}`);
    combinedParts.push(`\n[↥ 目次へ](#3行日記（全件まとめ）)\n\n---\n`);
  }

  // まとめファイル出力
  fs.writeFileSync(ALL_MD_PATH, combinedParts.join(''), 'utf8');
  console.log(`📚 wrote combined: ${path.relative(process.cwd(), ALL_MD_PATH)}`);
}

syncDiary().catch((e) => {
  console.error('❌ Error during sync:', e);
  process.exit(1);
});
