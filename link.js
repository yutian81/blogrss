const YML = require('yamljs');
const fs = require('fs');

// ============ 配置 ============
const blacklist = ['FloatSheep', '友站名称2', '友站名称3'];
const API_L1 = (url) => `https://v2.xxapi.cn/api/status?url=${encodeURIComponent(url)}`;
const API_L2 = (url) => `https://link-check.qa.ccwu.cc/api/status?url=${encodeURIComponent(url)}`;
const CHECK_TIMEOUT = 5000;
const MAX_GROUPS = 3;

// ============ 工具函数 ============
async function fetchWithTimeout(url, options = {}, timeout = CHECK_TIMEOUT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function checkL1(url) {
  try {
    const resp = await fetchWithTimeout(API_L1(url));
    const data = await resp.json();
    return data.code === 200;
  } catch {
    return null;
  }
}

async function checkL2(url) {
  try {
    const resp = await fetchWithTimeout(API_L2(url));
    const data = await resp.json();
    return data.status === 'reachable';
  } catch {
    return null;
  }
}

async function checkUrl(url) {
  const l1 = await checkL1(url);
  if (l1 === true) return true;
  if (l1 === false) return false;
  const l2 = await checkL2(url);
  if (l2 === true) return true;
  return false;
}

// ============ YAML 文本操作 ============

/** 扫描原始文本，提取被 "# " 注释掉的条目（name + link）
 *  注意：跳过整块被注释的分组（#- class_name:）内部的条目
 */
function extractCommentedEntries(rawText) {
  const lines = rawText.replace(/\r\n/g, '\n').split('\n');
  const entries = [];
  let curName = null;
  let curLink = '';
  let inCommentedGroup = false; // 是否在整块被注释的分组内

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // 跟踪整块被注释的分组
    if (/^#- class_name:/.test(line)) { inCommentedGroup = true; }
    if (!line.startsWith('#') && !/^\s*$/.test(line)) { inCommentedGroup = false; }

    // 跳过整块被注释分组内部的条目
    if (inCommentedGroup) continue;

    const nameMatch = line.match(/^#(\s+)- name:\s+(.+)$/);
    if (nameMatch) {
      if (curName && curLink) entries.push({ name: curName, link: curLink });
      curName = nameMatch[2].trim();
      curLink = '';
    } else if (curName) {
      const linkMatch = line.match(/^#\s+link:\s+(.+)$/);
      if (linkMatch) curLink = linkMatch[1].trim();
      if (!line.startsWith('#')) {
        if (curLink) entries.push({ name: curName, link: curLink });
        curName = null;
        curLink = '';
      }
    }
  }
  if (curName && curLink) entries.push({ name: curName, link: curLink });
  return entries;
}

/** 将指定条目（通过 name 定位）逐行添加 "# " 注释 */
function commentOutEntries(rawText, itemsToComment) {
  const lines = rawText.replace(/\r\n/g, '\n').split('\n');
  const nameSet = new Set(itemsToComment.map((i) => i.name));
  const sections = [];
  let current = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const nameMatch = line.match(/^(\s+)- name:\s+(.+)$/);
    if (nameMatch) {
      if (current) { current.end = i - 1; sections.push(current); }
      current = { name: nameMatch[2].trim(), start: i, end: -1 };
    }
    if (/^- class_name:/.test(line) && current) {
      current.end = i - 1; sections.push(current); current = null;
    }
  }
  if (current) { current.end = lines.length - 1; sections.push(current); }

  let commentedCount = 0;
  for (const s of sections) {
    if (nameSet.has(s.name)) {
      for (let i = s.start; i <= s.end; i++) {
        if (!lines[i].startsWith('#')) lines[i] = '# ' + lines[i];
      }
      commentedCount++;
    }
  }
  return { text: lines.join('\n'), commentedCount };
}

/** 将指定条目（通过 name 定位）取消 "# " 注释
 *  注意：跳过整块被注释的分组（#- class_name:）内部的条目
 */
function uncommentEntries(rawText, itemsToUncomment) {
  const lines = rawText.replace(/\r\n/g, '\n').split('\n');
  const targetNames = new Set(itemsToUncomment.map((i) => i.name));
  let uncommentedCount = 0;
  let inCommentedGroup = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (/^#- class_name:/.test(line)) inCommentedGroup = true;
    if (!line.startsWith('#') && !/^\s*$/.test(line)) inCommentedGroup = false;

    if (inCommentedGroup) continue;

    const nameMatch = line.match(/^#(\s+)- name:\s+(.+)$/);
    if (nameMatch && targetNames.has(nameMatch[2].trim())) {
      uncommentedCount++;
      for (let j = i; j < lines.length; j++) {
        const l = lines[j];
        if (!l.startsWith('#')) break;
        // 遇到不同名称的已注释条目则停止（避免误取消后面条目）
        const nextEntry = l.match(/^#(\s+)- name:\s+(.+)$/);
        if (nextEntry && j > i && !targetNames.has(nextEntry[2].trim())) break;
        if (l.startsWith('# ')) lines[j] = l.slice(2);
        else if (l.startsWith('#')) lines[j] = l.slice(1);
      }
    }
  }
  return { text: lines.join('\n'), uncommentedCount };
}

// ============ 主逻辑 ============
async function main() {
  const YML_PATH = 'source/_data/link.yml';
  console.log('读取 link.yml ...\n');

  // 读取原始文本
  const rawText = fs.readFileSync(YML_PATH).toString();
  const parseText = rawText.replace(/(?<=rss:)\s*\n/g, ' ""\n');

  // 解析活跃条目
  let yamlData;
  try {
    yamlData = YML.parse(parseText);
  } catch (err) {
    console.error('❌ 读取 link.yml 失败:', err.message);
    process.exit(1);
  }

  // 收集活跃条目
  const activeEntries = [];
  yamlData.forEach((g) => (g.link_list || []).forEach((i) => activeEntries.push(i)));

  // 收集被注释的条目
  const commentedEntries = extractCommentedEntries(rawText);

  // 合并所有 URL 去重检测
  const allItems = [...activeEntries, ...commentedEntries];
  const uniqueUrls = [...new Set(allItems.map((e) => e.link))];
  console.log(`共 ${uniqueUrls.length} 个唯一链接（活跃 ${activeEntries.length} + 已注释 ${commentedEntries.length}），开始检测可达性...\n`);

  const startTime = Date.now();
  const urlResults = await Promise.all(
    uniqueUrls.map(async (url) => ({ url, reachable: await checkUrl(url) }))
  );
  const elapsed = Date.now() - startTime;
  const reachabilityMap = Object.fromEntries(urlResults.map((r) => [r.url, r.reachable]));

  // 输出每个活跃条目的检测结果
  for (const item of activeEntries) {
    const ok = reachabilityMap[item.link];
    console.log(`  ${ok ? '✅ [可达]' : '❌ [不可达]'} ${item.name} - ${item.link}`);
  }

  // 对 YAML 文本进行修改
  let modifiedText = rawText;
  const toComment = activeEntries.filter((i) => reachabilityMap[i.link] === false);
  const toUncomment = commentedEntries.filter((i) => reachabilityMap[i.link] === true);

  if (toComment.length > 0) {
    const { text, commentedCount } = commentOutEntries(modifiedText, toComment);
    modifiedText = text;
    toComment.forEach((i) => console.log(`  💬 [已注释] ${i.name} - ${i.link}`));
  }
  if (toUncomment.length > 0) {
    const { text, uncommentedCount } = uncommentEntries(modifiedText, toUncomment);
    modifiedText = text;
    toUncomment.forEach((i) => console.log(`  🔄 [已取消注释] ${i.name} - ${i.link}`));
    console.log('   （链接已恢复，如需保留可删除行首 "# "）');
  }

  if (toComment.length > 0 || toUncomment.length > 0) {
    fs.writeFileSync(YML_PATH, modifiedText);
    console.log(`\n✅ link.yml 已更新`);
  } else {
    console.log('\n✅ 所有链接均可达，link.yml 无需修改');
  }

  // 重新解析修改后的 YAML，生成 friend.json
  const updatedYaml = YML.parse(modifiedText.replace(/(?<=rss:)\s*\n/g, ' ""\n'));
  let friends = [];
  updatedYaml.forEach((entry, index) => {
    if (index < MAX_GROUPS) {
      const filtered = entry.link_list.filter(
        (item) => !blacklist.includes(item.name)
      );
      friends = friends.concat(filtered);
    }
  });

  fs.writeFileSync(
    './source/friend.json',
    JSON.stringify({ friends: friends.map((i) => [i.name, i.link, i.avatar]) }, null, 2)
  );
  console.log(`✅ friend.json 已生成（${friends.length} 个友链，总耗时 ${elapsed}ms）\n`);
}

main().catch((err) => {
  console.error('❌ 脚本执行出错:', err);
  process.exit(1);
});
