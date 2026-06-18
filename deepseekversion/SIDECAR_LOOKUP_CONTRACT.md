# DeepSeek 联网证据包 Sidecar 协议

前端插件入口在 `src/islandmilfcode/plugins/deepseek-web-lookup.ts`。

它不会让主模型直接联网，也不会把网页原文塞进正文 prompt。流程是：

```text
scenePresence 前置门控
  ↓
POST 本地 sidecar
  ↓
sidecar 搜索 / 抓取 / 去重 / 蒸馏
  ↓
返回 evidencePacks
  ↓
只注入 scenePresence 副任务
```

## 启用方式

默认关闭。运行时需要写入：

```json
{
  "runtimeFlags": {
    "deepSeekWebLookup": {
      "enabled": true,
      "endpoint": "http://127.0.0.1:8787/lookup-character-detail",
      "timeoutMs": 6000,
      "maxEvidencePacks": 4
    }
  }
}
```

## 请求

```http
POST /lookup-character-detail
Content-Type: application/json
```

```json
{
  "request": {
    "intent": "canon_timeline",
    "query": "冴えない彼女の育てかた 2011 恋するメトロノーム 2012 クラス分け 紅坂朱音 2013",
    "reason": "当前轮涉及原作时间线、分班或红坂朱音/黑金二人组等容易倒灌的 canon 事实。",
    "characterId": "akane",
    "detailType": "timeline"
  },
  "worldTime": "2012-03-31 08:30",
  "location": "东京"
}
```

`intent` 可选：

- `canon_timeline`
- `appearance`
- `design_small_detail`
- `first_appearance_bootstrap`

## 响应

```json
{
  "evidencePacks": [
    {
      "kind": "CANON_FACT",
      "characterId": "akane",
      "source": "web-cache:sha256-or-url-hash",
      "confidence": "medium",
      "facts": [
        "红坂朱音挖走黑金二人组属于2013年2月后的事件。",
        "2012年3月末只能作为未来业界压力或人物背景，不应当作已发生。"
      ],
      "mustFollow": [
        "早于2013-02时，不把黑金二人组离队写成既成事实。"
      ],
      "mustNotInfer": [
        "不得把未来事件自动倒灌到当前世界状态。"
      ],
      "appliesWhen": "scenePresence 判定、时间线纠偏、红坂朱音相关背景出现时"
    }
  ]
}
```

允许返回单个对象或数组；前端会归一化为 `evidencePacks`。

## 约束

- 只返回蒸馏事实，不返回网页长原文。
- `low` 置信度只用于“不要脑补”，不要作为强事实。
- 证据包只进入 `scenePresence` 副任务，用于 `present/focus/absent/uncertain`、`appearanceGuards` 和 `plotImpact`。
- 如果证据包与最近正文已经发生的蝴蝶效应冲突，以最近正文的新因果为准，并要求副任务在 `evidence` 或 `plotImpact.causalTrace` 写明覆盖原因。
