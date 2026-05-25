---
name: sillytavern-ejs-variables
description: Work with SillyTavern EJS and ST-Prompt-Template extension variables, worldbook entries, decorators, injections, MVU stat_data paths, render-only status bars, and multi-stage personality/palette prompts. Use when creating, fixing, reviewing, or explaining EJS code in worldbook entries, presets, character cards, or chat messages, especially when the task involves getvar/setvar, getwi/activewi, @@ decorators, @INJECT, injectPrompt, or MVU-based phase branching.
---

# SillyTavern EJS Variables

Use this skill to write or review EJS for SillyTavern + ST-Prompt-Template. Prioritize working code, correct runtime placement, and prompt output that is easy to inspect in the prompt viewer.

## Execution Model

EJS can run in worldbook entries, preset prompts, character card definitions, and messages.

Treat text outside EJS tags as prompt text that will be sent or rendered according to the entry placement. Treat EJS tags as logic used to decide which text, entries, or injected prompts appear.

Common goals:

- Gate prompt text by MVU variables such as affection, trust, relationship, weather, or route.
- Load one of several worldbook entries with `await getwi(...)`.
- Activate entries dynamically with `await activewi(...)`.
- Render status bars with `@@render_after` / `@@iframe`.
- Insert precise prompt fragments with `@INJECT` or `injectPrompt(...)`.
- Build one-entry multi-stage personality/palette systems.

## Work Procedure

1. Identify the runtime target: prompt content, worldbook activation, render-only UI, initial variables, or message injection.
2. Identify the variable source and scope. MVU paths must use `stat_data.`.
3. Choose the smallest pattern that fits:
   - Conditional text: `if/else` inside one entry.
   - Multi-entry stage system: controller entry + disabled stage entries + `await getwi`.
   - Single-entry palette: one constant entry with all stage branches inline.
   - Status bar: `@@render_after` plus `@@iframe`.
   - Dynamic green-light activation: `@@preprocessing` or `@@generate_before` + `activewi`.
   - Precise prompt placement: `@INJECT` or `injectPrompt`.
4. Write EJS with whitespace-trimming tags and defensive variable reads.
5. Validate with the checklist at the end before finalizing.

## 0-Layer Same-Level Character Cards

For high-quality AIRP, treat model attention as the scarce resource even when token cost is not a concern. Do not keep every heroine's full 0-layer character definition active at the same time.

Use this split of responsibility:

- Worldbook EJS controls full same-level character card definitions.
- Code such as `relationship.ts` controls short, current-target relationship overlays.

Put large stable character definitions in worldbook entries, for example `<Kasumigaoka Utaha> ... </Kasumigaoka Utaha>` inside `路人女主.json`. Gate them with EJS, `@@if`, worldbook activation rules, or a controller entry so only the currently relevant heroine's full card appears.

Keep `relationship.ts` for compact dynamic guidance:

- current affinity / obsession stage;
- address and nickname rules;
- short relationship boundary reminders;
- local behavior audit for the active target;
- phone or scene-specific micro-guidance.

Do not put the full 0-layer card body in `relationship.ts`. Code-side injection is too global and too easy to keep active across scenes, which dilutes attention and makes characters bleed into each other. It should output a small overlay that modifies the active character, not a replacement for the worldbook's full card.

Recommended architecture:

```text
Worldbook:
  Character full card entries:
    <Kasumigaoka Utaha>...</Kasumigaoka Utaha>
    <Sawamura Spencer Eriri>...</Sawamura Spencer Eriri>
    <Kato Megumi>...</Kato Megumi>

  Controller or EJS gate:
    read active target / scene / location / event
    include exactly the relevant full card(s)

relationship.ts:
  read active target status
  inject only short stage, address, and audit overlay
```

Use `relationship.ts` only for text that must change almost every turn. Use worldbook EJS for text that is long, stable, character-specific, and expensive for attention.

When the user asks where to place a rule, apply this decision table:

| Content type | Best place | Reason |
| --- | --- | --- |
| Full heroine persona, background, speech style, original relationship anchors | Worldbook entry | Large stable context should be activated only when needed. |
| Multi-stage personality palette for one heroine | Worldbook EJS entry | Stage branches can be gated before reaching the model. |
| Current affection / obsession effect | `relationship.ts` | Small numeric overlay changes frequently. |
| Addressing rules based on player input or current target | `relationship.ts` | Short, procedural, active-target specific. |
| Scene/event-specific original plot reference | Worldbook event entry | Belongs to story context, not relationship overlay. |
| Cross-character audit that prevents bleed | `relationship.ts` only if very short; otherwise worldbook gated entry | Keep always-on text minimal. |

For same-level card definitions, prefer one active full card plus one small relationship overlay. If multiple heroines are present in a scene, include only the full cards required for actual dialogue/action, and keep non-speaking characters in event context or short reminders.

Example controller for worldbook-side full card selection:

```ejs
<%_
if (typeof activeTargetId === 'undefined') var activeTargetId = getvar('stat_data.activeTargetId', { defaults: '' });
if (typeof sceneTargets === 'undefined') var sceneTargets = getvar('stat_data.world.sceneTargetIds', { defaults: [] });
var ids = Array.isArray(sceneTargets) ? sceneTargets : [];
var shouldLoadUtaha =
  activeTargetId === 'utaha' ||
  ids.includes('utaha') ||
  getvar('stat_data.world.currentMainEventId', { defaults: '' }) === 'SAE_01-6';
_%>
<%_ if (shouldLoadUtaha) { _%>
<%- await getwi('霞之丘诗羽') %>
<%_ } _%>
```

If the target IDs in the project are not stable, match by `activeTargetId`, target name, alias, or `meta.worldbookEntryName`, but keep this matching logic in one controller instead of scattering it across every card.

## Core Syntax

Use these tags:

```ejs
<%_ code _%>       <%# run code, output nothing, trim whitespace %>
<%= expression %>  <%# output escaped value %>
<%- expression %>  <%# output raw value %>
<%# comment %>     <%# EJS comment %>
```

Prefer `<%_ ... _%>` for logic blocks because prompt whitespace matters.

Use strict comparisons for text:

```ejs
<%_ if (getvar('stat_data.天气') === '晴天') { _%>
晴天时发送的提示词
<%_ } _%>
```

Use `&&` and `||` for combined conditions:

```ejs
<%_ if (gw >= 500 && rel !== '恋人') { _%>
好感很高但尚未确认恋人关系时的提示词
<%_ } _%>
```

## Variables

Always include `stat_data.` for MVU variables:

```ejs
getvar('stat_data.角色.好感度')
getvar('stat_data.角色.关系状态', { defaults: '陌生人' })
```

Do not add array indexing to normal MVU paths:

```ejs
getvar('stat_data.角色.好感度')      <%# correct %>
getvar('stat_data.角色.好感度[0]')   <%# wrong %>
```

When multiple entries may share variable names, avoid redeclaration errors with `typeof` + `var`, or add `@@private` to isolate the entry scope:

```ejs
<%_
if (typeof gw === 'undefined') var gw = getvar('stat_data.角色.好感度', { defaults: 0 });
if (typeof rel === 'undefined') var rel = getvar('stat_data.角色.关系状态', { defaults: '陌生人' });
_%>
```

Avoid `const` and `let` in reusable worldbook snippets because repeated entry execution can redeclare names.

Read and write variables:

```ejs
getvar('path')
getvar('path', { defaults: 0 })
setvar('key', value, { scope: 'local' })
setvar('key', value, { scope: 'message' })
setvar('key', value, { flags: 'nx' })
setvar('key', value, 'global')
incvar('好感度', 5, { scope: 'local', min: 0, max: 100 })
decvar('金币', 100, { scope: 'local', min: 0 })
delvar('key')
delvar('key', '属性名')
insvar('数组', '新元素')
```

Scopes:

- `message`: persistent variable bound to a message floor; default write scope.
- `local`: persistent chat variable for the current chat.
- `global`: persistent variable shared across characters and chats.
- `cache`: temporary variable, not persisted.
- `initial`: read-only initial variable.

Variable priority from high to low: newest message variable, older message variables, local chat variable, global variable.

If reading immediately after `setvar`, pass `{ noCache: true }` to avoid stale cached values:

```ejs
<%_
setvar('flag', true, { scope: 'local' });
var flagNow = getvar('flag', { noCache: true });
_%>
```

## Output Patterns

Use `print(...)` when output is built inside a code block:

```ejs
<%_
if (getvar('stat_data.天气') === '晴天') {
  print('【阳光明媚，适合出门】');
}
_%>
```

Use raw output for worldbook entry content:

```ejs
<%- await getwi('条目名') %>
```

Use serialization when showing structured state:

```ejs
<%= getvar('stat_data.角色.好感度') %>
<%= JSON.stringify(getvar('stat_data')) %>
<%= YAML.stringify(getvar('stat_data'), { blockQuote: 'literal' }) %>
```

## Worldbook Loading

`getwi` is async. Always use `await`.

```ejs
<%- await getwi('条目名') %>
<%- await getwi('世界书名', '条目名') %>
<%- await getwi('条目名', { key: value }) %>
```

Controller + disabled stage entries:

```ejs
<%_
if (typeof gw === 'undefined') var gw = getvar('stat_data.角色.好感度', { defaults: 0 });
_%>
<%_ if (gw < 30) { _%>
<%- await getwi('角色_阶段01') %>
<%_ } else if (gw < 60) { _%>
<%- await getwi('角色_阶段02') %>
<%_ } else { _%>
<%- await getwi('角色_阶段03') %>
<%_ } _%>
```

Recommended configuration:

- Controller entry: constant/blue-light activation.
- Stage entries: disabled; loaded only by `getwi`.
- Put shared logic in the controller.
- Keep stage content free of additional recursive loading unless needed.

## Active Worldbook Entries

Use `activewi` when SillyTavern should handle native activation behavior such as green lights, vectorization, and entry rules.

`activewi` must run in `[GENERATE:BEFORE]` or `@@generate_before`.

```ejs
<%_
await activewi('条目名');
await activewi('条目名', true); // force activation
_%>
```

Use `getwi` when you want to directly include an entry's rendered content. Use `activewi` when you want the entry to enter the normal worldbook activation pipeline.

## Chat Message Helpers

Use these for message-aware conditions:

```ejs
getChatMessage(idx)
getChatMessages(count)
getChatMessages(start, end)
matchChatMessages(['关键词'])
matchChatMessages(['关键词'], { start: -4 })
matchChatMessages([/正则/s])
```

Example:

```ejs
<%_ if (matchChatMessages(['晚安'], { start: -4 })) { _%>
角色注意到最近几楼出现过晚安。
<%_ } _%>
```

## Decorators

Decorators must appear at the start of the entry, one per line, with no blank lines between decorators.

```text
@@activate
@@generate_after
@@private
```

Common decorators:

- `@@activate`: treat as permanently active blue-light entry.
- `@@dont_activate`: prevent activation.
- `@@generate_before`: inject near the beginning of the prompt.
- `@@generate_after`: inject near the end of the prompt.
- `@@render_before`: render before a message; not sent to AI.
- `@@render_after`: render after a message; not sent to AI.
- `@@preprocessing`: execute before worldbook processing; useful for dynamic activation text.
- `@@initial_variables`: treat content as initial variables.
- `@@private`: wrap scope to avoid repeated declaration conflicts.
- `@@if condition`: exclude the entry when condition is false.
- `@@iframe`: render in an iframe to avoid style pollution.
- `@@iframe 标题文字`: render as a collapsible iframe.

Example:

```ejs
@@if variables.好感度 >= 90
好感度很高时才发送的内容
```

Do not combine `@@preprocessing` with `@@generate_before` or `@@generate_after` in the same entry.

## Entry Prefixes And Injection

Entry title or memo prefixes:

- `[GENERATE:BEFORE]`: prompt beginning; blue-light entries only.
- `[GENERATE:AFTER]`: prompt ending; blue-light and green-light entries.
- `[RENDER:BEFORE]`: render before message; not sent to AI.
- `[RENDER:AFTER]`: render after message; not sent to AI.
- `[InitialVariables]`: initial variables as standard JSON.

`@INJECT` inserts an independent `{ role, content }` message into the prompt. The `@INJECT` entry itself must be disabled.

```text
@INJECT pos=1,role=system
@INJECT pos=-1,role=user
@INJECT target=user,index=1,at=before,role=system
@INJECT target=assistant,index=-1,at=after,role=user
@INJECT regex=你好,at=before,role=system
```

Use `injectPrompt` for dependency-inverted prompt fragments: worldbook entries define fragments, presets decide placement.

Worldbook:

```ejs
<% injectPrompt('CoT', `思考步骤内容`) %>
```

Preset:

```ejs
<%- getPromptsInjected('CoT') %>
```

## Render-Only Status Bars

Use render decorators for UI that should not be sent to the model.

```ejs
@@render_after
@@iframe
@@if !is_user && !is_system
<html>
<body>
<div>
好感度：<%- variables.stat_data.角色.好感度 %>
</div>
</body>
</html>
```

Collapsible version:

```ejs
@@render_after
@@iframe 状态栏（点击展开）
@@if !is_user && !is_system
<html>
<body>...</body>
</html>
```

Render-only constants available when `runType === 'render'`:

- `message_id`
- `is_last`
- `is_user`
- `is_system`

## Dynamic Green-Light Activation

Use `@@preprocessing` to emit temporary activation text before worldbook processing.

```ejs
@@preprocessing
<%_ if (getvar('stat_data.天气') === '晴天') { _%>
晴天关键词
<%_ } _%>
```

Then configure another entry to activate on `晴天关键词`.

Requirement: SillyTavern 1.13.4+.

## Single-Entry Multi-Stage Palette

Use this pattern when the user wants one constant entry containing all stages, rather than controller + disabled stage entries.

Prerequisites:

- MVU schema has the stage variables, usually in `schema.ts`.
- Initial variables exist, usually in `initvar.yaml`.
- Variable update rules maintain those values.

Template:

```ejs
<%_
if (typeof gw === 'undefined') var gw = getvar('stat_data.角色.好感度', { defaults: 0 });
if (typeof rel === 'undefined') var rel = getvar('stat_data.角色.关系状态', { defaults: '陌生人' });
_%>

性格调色盘：人的性格就像调色盘，由多种性格衍生组合而成才是活生生的人

<%_ if (rel !== '恋人') { _%>
<%_ if (gw < 500) { _%>
底色：[阶段1底色]
主色调：[阶段1主色调]
性格点缀：[阶段1点缀]
<%_ } else { _%>
底色：[阶段2底色]
主色调：[阶段2主色调]
性格点缀：[阶段2点缀]
<%_ } _%>
<%_ } else { _%>
底色：[恋人阶段底色]
主色调：[恋人阶段主色调]
性格点缀：[恋人阶段点缀]
<%_ } _%>

<%_ if (gw < 250) { _%>
[阶段1专属衍生]
<%_ } _%>

<%_ if (gw >= 250 && gw < 500) { _%>
[阶段2专属衍生]
<%_ } _%>

<%_ if (gw >= 500 && rel !== '恋人') { _%>
[阶段3专属衍生]
<%_ } _%>

<%_ if (rel === '恋人') { _%>
[恋人阶段专属衍生]
<%_ } _%>

[跨阶段通用衍生，放在所有 if/else 外面，始终显示]

对角色的理解与思考:

<%_ if (gw < 250) { _%>
[阶段1专属二次解释]
<%_ } _%>

<%_ if (gw >= 250 && gw < 500) { _%>
[阶段2专属二次解释]
<%_ } _%>

<%_ if (gw >= 500 && rel !== '恋人') { _%>
[阶段3专属二次解释]
<%_ } _%>

<%_ if (rel === '恋人') { _%>
[恋人阶段专属二次解释]
<%_ } _%>

[跨阶段通用二次解释，放在所有 if/else 外面，始终显示]

总结: |
  这就是[角色名]的性格调色盘...
```

Recommended stage conditions:

```text
gw < 250                    初识期
gw >= 250 && gw < 500       熟悉期
gw >= 500 && gw < 750       暧昧期
gw >= 750                   深入期
rel === '恋人'              恋人专属阶段
```

For relationship + affection systems, decide relationship overrides first. A common rule is:

```ejs
rel !== '恋人' 时按好感度分段
rel === '恋人' 时使用恋人专属内容
```

Recommended entry configuration:

- Constant/blue-light activation.
- Position after character definition.
- Order `99`.
- Enable non-recursive / prevent further recursion when the UI exposes those options.
- Keep it as one entry if the chosen architecture is single-entry palette.

## Function Definitions

Inside `define(...)`, use a normal function and access helpers through `this`.

```ejs
<%_
define('fn', function() {
  return this.getvar('key');
});
_%>
```

Avoid arrow functions here:

```ejs
<%_
define('fn', () => getvar('key')); // wrong
_%>
```

## Built-In Constants And Helpers

Common constants:

- `variables`: merged variables object.
- `_`: Lodash.
- `$`: jQuery.
- `toastr`: notifications, e.g. `toastr.info(...)`.
- `userName`
- `charName`
- `lastMessageId`
- `lastUserMessage`
- `lastCharMessage`
- `generateType`: `normal`, `continue`, `regenerate`, `swipe`.
- `runType`: `generate`, `preparation`, `render`.

Function groups:

- Variables: `getvar`, `setvar`, `incvar`, `decvar`, `delvar`, `insvar`, `define`, `patchVariables`.
- Worldbook: `await getwi`, `await activewi`, `await getEnabledWorldInfoEntries`.
- Character / preset / quick reply: `await getchar`, `await getpreset`, `await getqr`, `await getCharData`.
- Messages: `getChatMessage`, `getChatMessages`, `matchChatMessages`.
- Output: `print`, `injectPrompt`, `getPromptsInjected`, `hasPromptsInjected`.
- Regex: `activateRegex`.
- Tools: `parseJSON`, `jsonPatch`, `await evalTemplate`, `await execute`.

Regex activation examples:

```ejs
<%_
activateRegex(/<think>[\s\S]*?<\/think>/gi, '');
activateRegex(/pattern/gi, '替换', { message: true, html: true });
_%>
```

## Debugging

Use the prompt viewer first: input box lower-left magic wand -> prompt viewer. Confirm the actual prompt content, not just the source entry text.

Other debug tools:

```ejs
<%_ console.log('message') _%>
<%_ toastr.info('message') _%>
<%_ alert('message') _%>
<%_ debugger; _%>
```

Open browser devtools before using `debugger`.

## Review Checklist

Check EJS syntax:

- `getwi` and other async helpers use `await`.
- MVU variable paths include `stat_data.`.
- Normal MVU paths do not use `[0]`.
- Reusable variable declarations use `typeof ... === 'undefined'` + `var`, or the entry uses `@@private`.
- Logic blocks use `<%_ ... _%>` where prompt whitespace matters.
- Every `{` has a matching `}`.
- `define(...)` uses `function() { ... }` and `this.getvar(...)`.
- `setvar` followed by immediate read uses `{ noCache: true }` if freshness matters.

Check decorators and placement:

- Decorators are at the top, one per line, with no blank lines.
- `activewi` appears only in `[GENERATE:BEFORE]` or `@@generate_before`.
- `@INJECT` entries are disabled.
- `@@preprocessing` is not combined with `@@generate_before` / `@@generate_after`.
- Render-only UI uses render decorators, not generate decorators.

Check multi-stage logic:

- Stage boundaries do not overlap and do not leave gaps.
- Combined conditions use `&&` when both requirements must be true.
- Relationship-specific stages such as `rel === '恋人'` are handled explicitly.
- Each stage-specific derivative has a matching stage-specific explanation.
- Cross-stage common derivatives and explanations live outside all stage branches.
- Palette header, derivatives, explanation, and summary are all present if building a palette entry.
