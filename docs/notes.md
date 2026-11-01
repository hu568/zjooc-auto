# 在浙学（zjooc.cn）学习页结构笔记

> 这些结论来自对站点前端源码（webpack 分包）的实际阅读，不是猜测。脚本的 Vue 优先 / DOM 兜底两套逻辑都据此编写。

## 1. 路由与分包

- 学习页：`/ucenter/student/course/study/:courseId/plan/detail/:chapterid`
- 主包：`https://www.zjooc.cn/dist/assets_<hash>/js/app.<hash>.js`
- 业务分包命名：`js/<chunkId>.<hash>.js`（由 webpack runtime 的 `r.p + "js/" + id + "." + hash + ".js"` 拼出）
- 学习页组件在 **chunk 28**（`plan-detail.vue` + `plan-detailvideo.vue`），弹题组件在 **chunk 239**（`plan-doTask.vue`）

## 2. 页面 DOM

```
.plan-detail                       // 学习页根，挂有 Vue 实例
├─ .el-header > ul > li            // 面包屑：[章, 节, 单元 + 类型]
├─ .base-asider                    // 左侧目录
│   └─ .el-submenu (章) > .el-menu-item (节)
└─ .el-main
    └─ .plan-detailvideo
        ├─ .el-tabs__nav .el-tabs__item     // 每个 tab = 节下的一个学习单元
        └─ .contain > .contain-video > video // 视频单元
           .contain .contain-bottom .el-button // 图文/PDF/音频的「完成学习」
```

tab 的标签里用图标表示状态：`<i class="iconfont icon-shipin complete|no-start">`（complete = 已完成）。

## 3. Vue 实例（脚本优先用它）

`.plan-detail.__vue__` 是学习页组件（`name: "detail"`）：

| 字段 / 方法 | 含义 |
| --- | --- |
| `list` | 章节目录树：`[章 {id,name,children:[节 {id,name,children:[单元]}]}]` |
| `thisData` | `[章, 节, 单元]` |
| `detailData` | 当前节（传给右侧 tabs 的 `datas`） |
| `tabClick({name})` | 切到同节内的某个单元（内部会 `$router.push`） |
| `fowardDetail(section)` | 切到另一节（跳到该节第一个单元） |
| `initPlan(id)` | 按章节 id 重新初始化 |
| `finishText()` | 调「完成学习」接口 |
| `player` | 当前播放器组件（CKPlayer 包装） |

`.plan-detailvideo.__vue__` 有 `activeNames`（取自路由参数）、`doTaskContent`、`dialogVisible`。

## 4. 接口

| 接口 | 用途 |
| --- | --- |
| `/jxxt/api/course/courseStudent/v2/getStudentCourseChapters` | 章节目录 |
| `/jxxt/api/course/courseStudent/videoProgress` | 断点（`playTime` / `percent`） |
| `/learningmonitor/api/learning/monitor/videoPlaying` | 每 20s 上报 `playTime` 与 `percent` |
| `/learningmonitor/api/learning/monitor/finishTextChapter` | 图文 / PDF 完成 |
| `/jxxt/api/course/courseResource/getSubtitleUrl` | 字幕（播放器初始化时调用） |
| `/question-base/api/question/get/teacher/{subjectId}` | 弹题题目 |

进度算法在客户端：

```js
percent = Math.round(time / duration * 100);
if (percent >= 95) percent = 100;
if (progressInfo.percent >= percent || percent === 0) return; // 不重复上报
```

所以倍速会加速完成，但**片尾要等 ended 或站点把 100% 上报**，否则容易停在 98%。

## 5. 播放器

定制 CKPlayer。控制条是 `video.parentElement.children[2]`，子元素顺序：

```
0 play     1 pause    2 dline-la  3 front   4 dline-lb  5 next
6 dline-lc 7 timetext 8 full      9 escfull 10 dline-ra 11 definition
12 dline-rb 13 playbackrate(默认隐藏) 14 dline-rc 15 subtitles 16 dline-rd
17 volume  18 mute    19 escmute
```

类名都带随机后缀（`controlbar<random>`），所以只能 `[class*="controlbar"]` 这样选。
脚本不点这些按钮，直接操作 `video` 元素（`playbackRate` / `muted` / `play`），更稳。

## 6. 弹题

播放到单元数据 `videoSubjectList[].timePoint` 时，播放器 emit `handleDoTask` → 暂停视频并弹出「答题」对话框。
`planDoTask` 提交时做的是：

```js
this.doTaskContent.answer === this.doTaskContent.rightAnswer
  ? 回答正确 → $emit("handleDoSubmit") → 关闭弹窗并恢复播放
  : 回答错误
```

即 **正确答案随题目一起下发到前端**，脚本可直接赋值 `answer = rightAnswer` 后调用 `handleSubmit()`。
多选（`type === 2`）需要先把 `rightAnswer` 按 `","` 拆成数组，组件内部会 `sort().join(",")` 后再比对。

## 7. OCS Desktop 的脚本安装机制

- 浏览器：playwright `launchPersistentContext` 拉起自带 Chrome for Testing，`--load-extension` 加载 `%APPDATA%/OCS Desktop/downloads/extensions/*`（本项目环境里是 ScriptCat 1.1.2）。
- 安装脚本：对每个脚本 `page.goto(url)` 触发脚本管理器安装页，再自动点「安装 / 更新」。
- 本地脚本会被拼成 `"file://" + 路径`；Chrome 扩展默认没有「允许访问文件网址」权限 ⇒ ScriptCat 拦不到 ⇒ 安装页不出现 ⇒ OCS 卡在「正在安装用户脚本…」。
- 可用姿势：把脚本放进 `resources/app/public/`（OCS 自带 express 静态目录，挂在 `http://localhost:15319/`），用「网络脚本」装。
