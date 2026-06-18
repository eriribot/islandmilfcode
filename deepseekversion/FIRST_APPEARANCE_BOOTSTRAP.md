# 初登场外貌 Bootstrap

本文档记录 DeepSeek 模式下的初登场识别方案。问题样本来自测试：波岛出海、町田苑子、红坂朱音在初登场或首次被镜头捕捉时，DS 容易把外貌写偏。

## 真实问题链路

这不是好感度低的问题。

当前链路是：

```text
用户输入 / 最近正文
  ↓
scenePresence 先判断 present / focus
  ↓
只有判进 present / focus 的角色，才注入完整世界书 0 层角色卡
  ↓
正文生成
```

因此初登场时存在一个空窗：如果 `scenePresence` 在前置判定阶段没有足够线索把角色判进 present/focus，后面的完整角色世界书卡和外貌锚点就不会进入 prompt。此时 DS 只能用角色名、泛化印象或常见模板补外貌。

DeepSeek 模式要补的是这个前置空窗，而不是按好感度加权。

## Bootstrap 层定位

`First Appearance Bootstrap` 是放在 `scenePresence` 前面的极短信号层。

它不是完整角色卡，也不是关系指导，只提供帮助 preflight 判中的最小识别信息：

- 角色 id。
- 姓名和别名。
- 初登场可识别外貌锚点。
- 常见出现入口。
- 不可脑补项。

它的作用是让 `scenePresence` 在完整世界书卡注入之前，就能识别“这个镜头里可能是谁”。

## 首批高风险角色

### `CHAR:izumi` 波岛出海

本地可用视觉来源：

- `src/islandmilfcode/picresource/izumi_phone.jpg`
- `src/islandmilfcode/picresource/izumi_film.jpg`
- `src/islandmilfcode/picresource/bizhi_izumi.jpg`

Bootstrap 候选：

```text
[BOOTSTRAP][CHAR:izumi][角色:波岛出海]
识别锚点：深红/酒红系双马尾；红粉系眼睛；双侧发饰。
出现入口：同人创作、后辈、绘画竞争、波岛/出海/Hashima/Izumi。
禁止脑补：不得写成金发；不得写成成熟御姐模板；不得无来源补巨乳或固定服装。
```

### `CHAR:sonoko` 町田苑子

本地可用视觉来源：

- `src/islandmilfcode/picresource/Sonoko_phone.png`

Bootstrap 候选：

```text
[BOOTSTRAP][CHAR:sonoko][角色:町田苑子]
识别锚点：深色/黑蓝系短发或利落侧发；蓝色系眼睛；成年编辑气质。
出现入口：编辑、霞诗子责编、町田/苑子/Sonoko/Machida。
禁止脑补：不得写成少女双马尾；不得写成金发模板；不得无来源补固定眼镜、巨乳或妖艳礼服。
```

### `CHAR:akane` 红坂朱音 / 高坂茜

本地可用视觉来源：

- `src/islandmilfcode/picresource/Akane_phone.png`
- `src/islandmilfcode/picresource/Akane_film.jpg`
- `src/islandmilfcode/picresource/bizhi_akane.jpg`

Bootstrap 候选：

```text
[BOOTSTRAP][CHAR:akane][角色:红坂朱音/高坂茜]
识别锚点：深酒红/紫红系长发；红粉/紫红系眼睛；成年创作者的压迫感。
出现入口：红坂朱音、高坂茜、朱音、rouge en rouge、创作压迫、业界修罗场。
禁止脑补：不得写成金发；不得写成萝莉或普通温柔大姐姐；不得无来源补眼镜、制服或固定露出服装。
```

## 注入时机

Bootstrap 层必须早于 `scenePresence`。

推荐流程：

```text
用户输入 / 最近正文 / 当前事件
  ↓
DeepSeek 初登场自检
  ↓
注入候选 BOOTSTRAP 索引到 scenePresence 副 API
  ↓
scenePresence 判定 present / focus
  ↓
命中后再注入完整 0 层世界书卡和 APPEARANCE guard
```

## 自检规则

每轮都做轻量自检，但不是每轮都把所有 bootstrap 塞进主 prompt。

触发 bootstrap 候选的情况：

- 用户输入明确点名或使用别名。
- 用户输入用外貌、职业、关系、作品、社团或地点描述某人。
- 当前主线事件即将让某个角色初登场。
- 最近正文出现“陌生女性/编辑/后辈/红发/双马尾/创作者/业界人”等可能指向角色的入口。
- 上一轮外貌写错，需要下一轮纠偏。

Bootstrap 只进入 `scenePresence` 或检索/判定副任务。只有角色被判为 present/focus 后，主 prompt 才注入完整卡和外貌证据包。

## 与联网检索的关系

初登场外貌优先查本地：

1. `picresource` 视觉资源。
2. 世界书角色条目。
3. 已确认 memoryDB 外貌锚点。
4. 最近正文。
5. 联网检索。

只有本地 bootstrap 不足以判定，且本轮确实需要写具体外貌时，才触发联网检索。联网结果也必须先蒸馏为 `BOOTSTRAP` 或 `APPEARANCE` 证据包。

## 验收标准

- 初登场角色不再因为“世界书卡尚未注入”而被 DS 用模板脸补齐。
- `scenePresence` 能根据别名、职业、外貌入口和剧情入口识别出海、苑子、朱音。
- 未判进 present/focus 的角色仍不注入完整 0 层卡，避免全员常驻。
- Bootstrap 不改变关系和剧情，只帮助前置判定识别角色身份。
