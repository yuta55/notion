/* eslint-disable no-console */
const { Client } = require('@notionhq/client');
const fs = require('fs');
const path = require('path');
const slugify = require('slugify');

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const databaseId = process.env.NOTION_DATABASE_ID;

// === あなたのDBに合わせてここを調整（プロパティ名） ===
const PROP_TITLE = 'タイトル'; // Title型
const PROP_DATE  = '日付';     // Date型
// タイトルで「3行日記」だけに絞るなら true、全件なら false
const ONLY_THREE_LINE = true;
// ================================================

const OUT_DIR = path.join(process.cwd(), 'diary');

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function plainText(rich = []) {
  return rich.map((r) => r.plain_text || '').join('');
}

// Notion → Markdown（最小実装。必要に応じて型を追加してOK）
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
      // 未対応型はコメントだけ残す（必要なら後で追加）
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
      sorts: [{ property: PROP_DATE, direction: 'descending' }],
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

  // 子を持つブロックは再帰取得（リスト・トグル等）
  const expanded = [];
  for (const b of blocks) {
    expanded.push(b);
    if (b.has_children) {
      const kids = await listAllChildren(b.id);
      // 子ブロックの前後に改行を挟むと読みやすい
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

// もし本文が「本文」などのリッチテキスト・長文プロパティに入っている場合のフォールバック
function extractRichTextPropertyMarkdown(page) {
  const candidateProps = ['本文', '内容', 'テキスト', 'Body', 'Content'];
  for (const key of candidateProps) {
    const prop = page.properties?.[key];
    if (prop?.type === 'rich_text' && prop.rich_text?.length) {
      return plainText(prop.rich_text) + '\n';
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
  const pages = await listAllPages(databaseId, filter);
  console.log(`✅ pages: ${pages.length}`);

  for (const page of pages) {
    const title = getTitle(page);
    const dateStr = getDate(page);
    const fname = fileNameFrom(dateStr, title);
    const fpath = path.join(OUT_DIR, fname);

    // 本文（ブロック）取得
    let md = `# ${title}\n\n`;
    if (dateStr && dateStr !== 'unknown') md += `- Date: ${dateStr}\n\n`;

    const blocks = await listAllChildren(page.id);

    if (blocks.length) {
      for (const b of blocks) md += blockToMarkdown(b);
    } else {
      // ページ本文が空のとき：リッチテキスト系プロパティをフォールバックとして書き出す
      const fallback = extractRichTextPropertyMarkdown(page);
      if (fallback) {
        md += fallback;
      } else {
        md += '_（本文なし）_\n';
      }
    }

    fs.writeFileSync(fpath, md, 'utf8');
    console.log(`📝 wrote: ${path.relative(process.cwd(), fpath)}`);
  }
}

syncDiary().catch((e) => {
  console.error('❌ Error during sync:', e);
  process.exit(1);
});
