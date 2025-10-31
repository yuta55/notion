const { Client } = require('@notionhq/client');
const fs = require('fs');
const path = require('path');

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const databaseId = process.env.NOTION_DATABASE_ID;

async function syncDiary() {
  const response = await notion.databases.query({
    database_id: databaseId,
    filter: {
      property: 'タイトル',  // 実際のプロパティ名に合わせる
      title: {
        contains: '3行日記'
      }
    }
  });

  const diaryDir = './diary';
  if (!fs.existsSync(diaryDir)) {
    fs.mkdirSync(diaryDir, { recursive: true });
  }

  for (const page of response.results) {
    const pageId = page.id;
    const pageContent = await notion.blocks.children.list({ block_id: pageId });
    
    // 日付やタイトルを取得
    const date = page.properties['日付']?.date?.start || 'unknown';
    const fileName = `${date.replace(/:/g, '-')}.md`;
    
    // コンテンツを整形してファイルに保存
    let content = `# 3行日記 - ${date}\n\n`;
    // ブロックの内容を処理...
    
    fs.writeFileSync(path.join(diaryDir, fileName), content);
  }
}

syncDiary().catch(console.error);
