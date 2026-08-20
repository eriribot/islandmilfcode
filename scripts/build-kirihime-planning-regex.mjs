import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const downloads = path.join(process.env.USERPROFILE || process.cwd(), 'Downloads');
const sourcePath = path.resolve(
  process.argv[2] || path.join(downloads, 'regex-新·星河璀璨数据库召回配套正则1.json'),
);
const outputPath = path.resolve(
  process.argv[3] || path.join(downloads, 'regex-夏野雾姬Island规划页边审稿.json'),
);

const sourceText = fs.readFileSync(sourcePath, 'utf8');
const source = JSON.parse(sourceText);
assert.equal(typeof source, 'object');
assert.equal(typeof source.id, 'string');
assert.ok(source.id, 'contract: the dedicated renderer keeps the installed renderer id');

const replacement = String.raw`\`\`\`html
<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>夏野雾姬 · 页边审稿</title>
<style>
:root{--paper:#242421;--paper-2:#1e1f1d;--line:#45443e;--ink:#dedbd2;--dim:#aaa69b;--mute:#747168;--red:#b05c57;--moss:#82926c;--blue:#7893a1;--shadow:rgba(0,0,0,.2)}
body.is-light{--paper:#f5f2ea;--paper-2:#ece8dd;--line:#d4ccbc;--ink:#393833;--dim:#69665e;--mute:#969084;--red:#8f4541;--moss:#62744e;--blue:#557584;--shadow:rgba(70,55,35,.08)}
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:transparent;color:var(--ink);font-family:"Noto Serif SC","Source Han Serif CN","Songti SC",serif;letter-spacing:0}
body{padding:8px}
button{font:inherit;letter-spacing:0}
.sheet{width:100%;overflow:hidden;border:1px solid var(--line);border-radius:2px;background:var(--paper);box-shadow:0 8px 24px var(--shadow)}
.head{display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:10px;padding:13px 16px;border-bottom:1px solid var(--line);background:var(--paper-2)}
.seal{width:30px;height:30px;display:grid;place-items:center;border:1px solid var(--red);color:var(--red);font-size:15px}
.title{min-width:0}.title strong{display:block;font-size:14px;font-weight:600}.title span{display:block;margin-top:2px;color:var(--mute);font-size:11px}
.tools{display:flex;gap:5px;align-items:center}.tool{min-width:30px;height:30px;padding:0 7px;border:1px solid var(--line);border-radius:2px;background:transparent;color:var(--dim);cursor:pointer}.tool:hover{color:var(--ink);border-color:var(--dim)}
.section{border-bottom:1px solid var(--line)}.section:last-child{border-bottom:0}.section.is-collapsed .section-body{display:none}
.section-head{display:flex;align-items:center;gap:9px;padding:11px 16px;background:var(--paper-2)}
.section-toggle{margin-left:auto;padding:3px 7px;border:1px solid var(--line);border-radius:2px;background:transparent;color:var(--mute);font-size:11px;cursor:pointer}.section-toggle:hover{color:var(--ink);border-color:var(--dim)}
.mark{width:22px;height:22px;display:grid;place-items:center;border:1px solid currentColor;font-size:11px}.mark-red{color:var(--red)}.mark-green{color:var(--moss)}.mark-blue{color:var(--blue)}
.section-head h2{margin:0;font-size:13px;font-weight:600}.meta{margin-left:auto;color:var(--mute);font-size:11px}
.body{padding:14px 16px}.text{margin:0;white-space:pre-wrap;word-break:break-word;color:var(--dim);font-size:13px;line-height:1.8}
.review-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1px;background:var(--line);border:1px solid var(--line)}
.review{min-width:0;padding:11px 12px;background:var(--paper)}.review-wide{grid-column:1/-1}.review b{display:block;margin-bottom:5px;color:var(--mute);font-size:10px;font-weight:500}.review p{margin:0;white-space:pre-wrap;word-break:break-word;font-size:12px;line-height:1.65}
.camera{display:flex;flex-wrap:wrap;gap:5px}.chip{display:inline-flex;max-width:100%;padding:3px 7px;border:1px solid var(--line);border-radius:2px;color:var(--dim);font-size:11px;word-break:break-word}.chip.present{border-color:var(--moss);color:var(--moss)}.chip.focus{border-color:var(--blue);color:var(--blue)}.chip.absent{color:var(--mute)}.chip.uncertain{border-style:dashed}
.memory{display:grid;grid-template-columns:minmax(100px,150px) 1fr;gap:12px}.memory-tabs{display:flex;flex-direction:column;gap:5px}.memory-tab{padding:7px 8px;border:1px solid var(--line);border-radius:2px;background:transparent;color:var(--dim);cursor:pointer;text-align:left;font-size:11px}.memory-tab.active{border-color:var(--moss);color:var(--moss);background:var(--paper-2)}
.memory-detail{min-height:86px;padding:11px 12px;border-left:2px solid var(--moss);background:var(--paper-2)}.memory-detail strong{display:block;margin-bottom:5px;font-size:12px}.memory-detail p{margin:0;color:var(--dim);font-size:12px;line-height:1.7;white-space:pre-wrap;word-break:break-word}.source{margin-top:7px;color:var(--mute);font-size:10px}
.evidence{display:grid;gap:7px}.evidence-item{padding-left:10px;border-left:2px solid var(--blue);color:var(--dim);font-size:12px;line-height:1.7;white-space:pre-wrap;word-break:break-word}
.empty{color:var(--mute);font-size:12px;font-style:italic}.foot{display:flex;justify-content:space-between;gap:8px;padding:9px 16px;background:var(--paper-2);color:var(--mute);font-size:10px}
@media(max-width:560px){body{padding:4px}.head{padding:11px 12px}.section-head,.body{padding-left:12px;padding-right:12px}.review-grid{grid-template-columns:1fr}.review-wide{grid-column:auto}.memory{grid-template-columns:1fr}.memory-tabs{display:grid;grid-template-columns:repeat(auto-fit,minmax(72px,1fr))}.memory-detail{border-left:0;border-top:2px solid var(--moss)}}
</style>
</head>
<body>
<script type="application/octet-stream" id="kirihimePayload">$1</script>
<main class="sheet">
  <header class="head">
    <span class="seal">雾</span>
    <div class="title"><strong>夏野雾姬 · 页边审稿</strong><span>镜头、因果与下一页约束</span></div>
    <div class="tools"><button class="tool" id="collapseAllBtn" title="收起所有区块" aria-label="收起所有区块">收</button><button class="tool" id="expandAllBtn" title="展开所有区块" aria-label="展开所有区块">展</button><button class="tool" id="copyBtn" title="复制本轮输入" aria-label="复制本轮输入">抄</button><button class="tool" id="themeBtn" title="切换纸张" aria-label="切换纸张">纸</button></div>
  </header>
  <section class="section" data-section="input">
    <div class="section-head"><span class="mark mark-red">稿</span><h2>本轮原稿</h2><button class="section-toggle" type="button" aria-expanded="false">展开</button></div>
    <div class="section-body"><div class="body"><p class="text" id="inputText"></p></div></div>
  </section>
  <section class="section" data-section="review" data-default-open="true">
    <div class="section-head"><span class="mark mark-red">批</span><h2>雾姬朱批</h2><span class="meta" id="cameraMeta"></span><button class="section-toggle" type="button" aria-expanded="true">收起</button></div>
    <div class="section-body"><div class="body"><div class="review-grid" id="reviewGrid"></div></div></div>
  </section>
  <section class="section" data-section="recall">
    <div class="section-head"><span class="mark mark-green">引</span><h2>召回引文</h2><span class="meta" id="recallMeta"></span><button class="section-toggle" type="button" aria-expanded="false">展开</button></div>
    <div class="section-body"><div class="body" id="memoryBody"></div></div>
  </section>
  <section class="section" data-section="supplement">
    <div class="section-head"><span class="mark mark-blue">证</span><h2>背景旁证</h2><span class="meta" id="supplementMeta"></span><button class="section-toggle" type="button" aria-expanded="false">展开</button></div>
    <div class="section-body"><div class="body"><div class="evidence" id="supplementBody"></div></div></div>
  </section>
  <footer class="foot"><span>规划只作页边约束，不进入正文</span><span id="loadTime"></span></footer>
</main>
<script>
(function(){
  'use strict';
  var started=Date.now();
  function decodePayload(){
    var encoded=(document.getElementById('kirihimePayload').textContent||'').trim();
    var binary=atob(encoded);var bytes=new Uint8Array(binary.length);
    for(var i=0;i<binary.length;i+=1)bytes[i]=binary.charCodeAt(i);
    return JSON.parse(new TextDecoder().decode(bytes));
  }
  function text(value){return String(value==null?'':value).trim()}
  function node(tag,className,value){var el=document.createElement(tag);if(className)el.className=className;if(value!==undefined)el.textContent=value;return el}
  function field(raw,name){
    var names='camera|causal_change|next_page|suppress_canon_return|appearance_constraints';
    var pattern=new RegExp('(?:^|\\n)'+name+':\\s*([\\s\\S]*?)(?=\\n(?:'+names+'):\\s*|$)','i');
    var match=raw.match(pattern);return match?text(match[1]):'';
  }
  function cameraField(raw,name){var block=field(raw,'camera');var match=block.match(new RegExp('(?:^|\\n)\\s*-\\s*'+name+':\\s*([^\\n]*)','i'));return match?text(match[1]):''}
  function appendReview(grid,label,value,className){var box=node('div','review'+(className?' '+className:''));box.appendChild(node('b','',label));box.appendChild(node('p','',value||'无'));grid.appendChild(box)}
  function renderCamera(grid,review){
    var box=node('div','review review-wide');box.appendChild(node('b','','镜头判定'));var row=node('div','camera');var count=0;
    [['present','在场'],['focus','转场'],['absent','离场'],['uncertain','存疑']].forEach(function(pair){
      var value=cameraField(review,pair[0]);if(!value||value==='无')return;count+=1;row.appendChild(node('span','chip '+pair[0],pair[1]+' · '+value));
    });
    if(!count)row.appendChild(node('span','empty','无明确镜头判定'));box.appendChild(row);grid.appendChild(box);return count;
  }
  function parseCodes(raw){var matches=text(raw).match(/AM\d+/gi)||[];return Array.from(new Set(matches.map(function(item){return item.toUpperCase()})))}
  function showMemory(detail,code,entry){detail.replaceChildren();detail.appendChild(node('strong','',entry&&entry.title?entry.title:code));detail.appendChild(node('p','',entry&&entry.body?entry.body:'未在当前数据库快照中找到该编码。'));detail.appendChild(node('div','source',entry&&entry.source?entry.source:'仅保留规划编码'))}
  function renderMemories(raw,entries){
    var codes=parseCodes(raw);document.getElementById('recallMeta').textContent='共 '+codes.length+' 条';var body=document.getElementById('memoryBody');
    if(!codes.length){body.appendChild(node('p','empty','本轮没有召回引文'));return}
    var wrap=node('div','memory');var tabs=node('div','memory-tabs');var detail=node('div','memory-detail');wrap.appendChild(tabs);wrap.appendChild(detail);body.appendChild(wrap);
    codes.forEach(function(code,index){var button=node('button','memory-tab'+(index===0?' active':''),code);var entry=entries&&entries[code]?entries[code]:null;button.addEventListener('click',function(){Array.from(tabs.children).forEach(function(item){item.classList.remove('active')});button.classList.add('active');showMemory(detail,code,entry);resize()});tabs.appendChild(button);if(index===0)showMemory(detail,code,entry)})
  }
  function renderSupplements(raw){var rows=text(raw).split(/\n+/).map(function(item){return item.replace(/^\s*-\s*/,'').trim()}).filter(Boolean);document.getElementById('supplementMeta').textContent='共 '+rows.length+' 条';var body=document.getElementById('supplementBody');if(!rows.length){body.appendChild(node('p','empty','本轮没有额外旁证'));return}rows.forEach(function(item){body.appendChild(node('div','evidence-item',item))})}
  function setSection(section,expanded){if(!section)return;section.classList.toggle('is-collapsed',!expanded);var toggle=section.querySelector('.section-toggle');if(toggle){toggle.setAttribute('aria-expanded',expanded?'true':'false');toggle.textContent=expanded?'收起':'展开'}}
  function setAllSections(expanded){Array.prototype.forEach.call(document.querySelectorAll('[data-section]'),function(section){setSection(section,expanded)});resize()}
  function bindSectionToggles(){Array.prototype.forEach.call(document.querySelectorAll('[data-section]'),function(section){var toggle=section.querySelector('.section-toggle');if(toggle)toggle.addEventListener('click',function(){setSection(section,section.classList.contains('is-collapsed'));resize()})});document.getElementById('collapseAllBtn').addEventListener('click',function(){setAllSections(false)});document.getElementById('expandAllBtn').addEventListener('click',function(){setAllSections(true)});Array.prototype.forEach.call(document.querySelectorAll('[data-section]'),function(section){setSection(section,section.getAttribute('data-default-open')==='true')})}
  function resize(){setTimeout(function(){try{parent.postMessage({type:'resizeIframe',height:document.documentElement.scrollHeight},'*')}catch(_error){}},20)}
  try{
    var payload=decodePayload();var input=text(payload.currentUserInput);var review=text(payload.kirihimeReview);
    document.getElementById('inputText').textContent=input||'（本轮输入为空）';var grid=document.getElementById('reviewGrid');var cameraCount=renderCamera(grid,review);
    appendReview(grid,'新因果',field(review,'causal_change'),'review-wide');appendReview(grid,'下一页',field(review,'next_page'),'review-wide');appendReview(grid,'抑制旧轨',field(review,'suppress_canon_return'),'');appendReview(grid,'外观约束',field(review,'appearance_constraints'),'');
    document.getElementById('cameraMeta').textContent=cameraCount?'镜头栏 '+cameraCount:'未分栏';
    renderMemories(payload.recall,payload.recallEntries||{});renderSupplements(payload.supplement);bindSectionToggles();
    var themeKey='kirihime-planning-paper';try{if(localStorage.getItem(themeKey)!=='dark')document.body.classList.add('is-light')}catch(_error){document.body.classList.add('is-light')}
    document.getElementById('themeBtn').addEventListener('click',function(){document.body.classList.toggle('is-light');try{localStorage.setItem(themeKey,document.body.classList.contains('is-light')?'light':'dark')}catch(_error){}resize()});
    document.getElementById('copyBtn').addEventListener('click',function(){var value=input||'';if(!value)return;if(navigator.clipboard&&window.isSecureContext)navigator.clipboard.writeText(value).catch(function(){});this.textContent='已';var self=this;setTimeout(function(){self.textContent='抄'},1200)});
    document.getElementById('loadTime').textContent='落笔 '+(Date.now()-started)+'ms';resize();
  }catch(error){document.querySelector('.sheet').replaceChildren(node('div','body text','规划面板读取失败：'+(error&&error.message?error.message:String(error))));resize()}
})();
</script>
</body>
</html>
\`\`\``.replaceAll('\\`', '`');

const renderer = {
  ...source,
  scriptName: '夏野雾姬·Island规划页边审稿',
  findRegex: '/以下是夏野雾姬规划B64:([A-Za-z0-9+/=]+)$/m',
  replaceString: replacement,
  trimStrings: [],
  placement: [1],
  disabled: false,
  markdownOnly: true,
  promptOnly: false,
  runOnEdit: true,
  substituteRegex: 0,
  minDepth: null,
  maxDepth: null,
};

assert.equal(renderer.id, source.id, 'contract: importing replaces the old renderer instead of stacking a duplicate');
assert.equal(renderer.findRegex, '/以下是夏野雾姬规划B64:([A-Za-z0-9+/=]+)$/m');
assert.match(renderer.replaceString, /夏野雾姬 · 页边审稿/);
assert.match(renderer.replaceString, /雾姬朱批/);
assert.match(renderer.replaceString, /召回引文/);
assert.match(renderer.replaceString, /背景旁证/);
assert.match(renderer.replaceString, /TextDecoder/);
assert.match(renderer.replaceString, /collapseAllBtn/);
assert.match(renderer.replaceString, /data-section="review"/);
assert.match(renderer.replaceString, /is-collapsed/);
assert.doesNotMatch(renderer.replaceString, /<本轮用户输入>|<current_user_input>|<planning_evidence>/);
assert.doesNotMatch(
  renderer.replaceString,
  /AutoCardUpdaterAPI|refreshDataAndWorldbook|exportTableAsJson|restoreTableAsJson|triggerUpdate|saveChat|generateRaw|TavernHelper\.generate/,
  'contract: mounting the planning renderer has zero plugin, table, save, trigger, or generation side effects',
);

const executableScripts = [...renderer.replaceString.matchAll(/<script>([\s\S]*?)<\/script>/gi)];
assert.equal(executableScripts.length, 1, 'contract: renderer has one executable inline script');
for (const match of executableScripts) {
  assert.doesNotThrow(() => new Function(match[1]), 'contract: renderer inline script parses');
}

const probePayload = Buffer.from(JSON.stringify({
  currentUserInput: '测试输入',
  recall: 'AM0001',
  supplement: '',
  kirihimeReview: 'camera:\n- present: user',
  recallEntries: {},
}), 'utf8').toString('base64');
const probeInput = `以下是夏野雾姬规划B64:${probePayload}`;
const probeRendered = probeInput.replace(/以下是夏野雾姬规划B64:([A-Za-z0-9+/=]+)$/m, renderer.replaceString);
assert.doesNotMatch(probeRendered, /\$1/, 'contract: regex replacement consumes the payload capture');
for (const match of probeRendered.matchAll(/<script>([\s\S]*?)<\/script>/gi)) {
  assert.doesNotThrow(() => new Function(match[1]), 'contract: inline script parses after Tavern regex replacement');
}
const legacyEntityPrefixPattern = /&(?:amp|lt|gt|quot|apos|nbsp)(?=[A-Za-z0-9_$])/g;
assert.equal(
  probeRendered.replace(legacyEntityPrefixPattern, '¤'),
  probeRendered,
  'contract: legacy entity decoding does not mutate the renderer bundle',
);

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(renderer, null, 2)}\n`, 'utf8');
assert.equal(fs.readFileSync(sourcePath, 'utf8'), sourceText, 'contract: source Xinghe renderer remains unchanged');
assert.deepEqual(JSON.parse(fs.readFileSync(outputPath, 'utf8')), renderer);

console.info(`[kirihime-planning-regex] generated and verified: ${outputPath}`);
