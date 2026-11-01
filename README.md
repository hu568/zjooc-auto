# ZJOOC 在浙学 · 自动刷课助手

一个跑在浏览器里的 **用户脚本（userscript）**，让 [在浙学 / 浙江省高等学校在线开放课程共享平台](https://www.zjooc.cn/) 的章节学习自动完成：
自动播放、倍速、静音、播完自动切下一节、图文 / PDF 自动点「完成学习」、视频弹题自动作答。

> 只做「正常播完 + 自动切章节」，**不拖进度条、不直接调接口**。站点开了强制观看（`forceLook`），拖动会被拉回。

## 安装地址

| 用途 | 地址 |
| --- | --- |
| 仓库 | <https://github.com/hu568/zjooc-auto> |
| 原始地址 | `https://raw.githubusercontent.com/hu568/zjooc-auto/main/zjooc-auto.user.js` |
| 国内镜像（raw 被 reset 时用） | `https://ghproxy.net/https://raw.githubusercontent.com/hu568/zjooc-auto/main/zjooc-auto.user.js` |

脚本管理器支持「从 URL 安装」时，直接填上面的镜像地址即可。

## 功能

| 功能 | 说明 |
| --- | --- |
| 自动播放 | 被暂停、缓冲卡住、切后台都会自动恢复；停滞 15s 触发重试 |
| 倍速 | 默认 2x，可选 1 / 1.25 / 1.5 / 2 / 3 / 4（直接设置 `video.playbackRate`，每轮自检纠正） |
| 静音 | 默认开启，避免自动播放被浏览器策略拦截 |
| 自动切换 | 同节内切 tab → 同章下一节 → 下一章第一节 |
| 跳过已完成 | 依据站点 `learnStatus === 2` 与 tab 上的 `i.complete` 标记 |
| 图文 / PDF / 音频 | 自动点「完成学习」，等待（默认 8s）后进下一节 |
| 弹题自动作答 | 视频播放到时间点弹出的「答题」框，直接取题目数据里的 `rightAnswer` 作答并恢复播放 |
| 后台播放 | 伪造 `document.hidden / visibilityState`，并每 30s 模拟鼠标移动 |
| 悬浮面板 | 可拖动 / 折叠，显示状态、当前章节、完成数、日志，可随时开始 / 暂停 / 下一节 |
| 配置持久化 | 设置存在 `localStorage`（`zjooc_auto_settings_v1`） |

## 安装

脚本是标准 `.user.js`，任何用户脚本管理器都能装（ScriptCat / Tampermonkey / Violentmonkey）。

### ScriptCat / Tampermonkey（推荐）

1. 安装脚本管理器扩展；
2. 打开管理面板 →「新建脚本 / 导入」→ 粘贴 [zjooc-auto.user.js](zjooc-auto.user.js) 全文，或直接把文件拖进去；
3. 保存并确认启用；
4. 打开 <https://www.zjooc.cn/> 登录，进入 **课程 → 章节学习**，右下角出现面板并自动开始。

### OCS Desktop（网课助手桌面端）

OCS Desktop 的浏览器是「Chrome for Testing + ScriptCat」，**不要**用它的「添加本地脚本」：

> ⚠️ 已知坑：OCS 会把本地脚本拼成 `file://<路径>` 去导航，而 Chrome 扩展默认没有「允许访问文件网址」权限，
> ScriptCat 在 `file://` 页面上拦截不到 `.user.js`，于是安装页永远不出现，OCS 会一直卡在 **「正在安装用户脚本…」**。

正确做法（实测可用）：把脚本放进 OCS 自带的静态目录，用它的本地 HTTP 服务安装：

```powershell
Copy-Item .\zjooc-auto.user.js "<OCS安装目录>\resources\app\public\zjooc-auto.user.js"
```

然后在 OCS 的「用户脚本」页添加**网络脚本**：`http://localhost:15319/zjooc-auto.user.js`，
启动浏览器后 ScriptCat 会弹安装页，OCS 自动点「安装」。

## 使用

1. 登录 <https://www.zjooc.cn/>；
2. 进入课程 →「章节学习」→ 点任意一节，地址形如
   `/ucenter/student/course/study/{课程ID}/plan/detail/{章节ID}`；
3. 右下角面板出现后 3 秒自动开始；
4. 面板里可随时调速 / 开关自动答题 / 跳过已完成；全部完成会提示「🎉 全部章节已完成」。

## 实现要点

站点是 Vue2 + Element-UI 的 SPA。脚本**优先驱动 Vue 实例**（`.plan-detail.__vue__` 暴露 `list / thisData / tabClick() / fowardDetail() / finishText()`），
拿不到时自动退回 DOM 点击，两条链路都有集成测试。更多细节见 [docs/notes.md](docs/notes.md)。

- 路由：`/ucenter/student/course/study/:courseId/plan/detail/:chapterid`
- 单元类型 `resourceType`：1 视频 / 2 音频 / 3 PDF / 4 图文；`learnStatus`：2 已完成 / 1 未开始
- 进度上报：站点每 20s 调 `/learningmonitor/api/learning/monitor/videoPlaying`，`percent = time / duration * 100`（≥95 记 100）
- 弹题：`planDoTask` 组件在本地做 `answer === rightAnswer` 比对，说明正确答案是下发到前端的

## 测试

```bash
node test/test.cjs normal   # 视频 → 图文 → 视频（含弹题）
node test/test.cjs skip     # 跳过已完成
node test/test.cjs novue    # 无 Vue 实例时的 DOM 兜底
```

测试用 playwright-core 驱动本机 Chrome 加载 `test/mock.html`（模拟学习页）。
默认寻找 OCS Desktop 自带的浏览器与 playwright-core，也可用环境变量 `CHROME_PATH` / `PW_CORE` 指定。

## 常见问题

**Q：`https://github.com/<user>/<repo>/blob/main/zjooc-auto.user.js` 为什么填进去报"脚本格式不正确"？**

那个地址是 GitHub 的**网页（HTML）**，不是脚本文本。OCS Desktop 的「网络脚本」会先 GET 这个地址、再从返回内容里解析 `// ==UserScript==` 元数据，
HTML 里当然没有 → 直接判定格式不正确；就算绕过校验，ScriptCat 拿到的也只是一张网页。

要用**原始文本**地址：

- 可以直连 raw 时：`https://raw.githubusercontent.com/hu568/zjooc-auto/main/zjooc-auto.user.js`
- 国内网络（raw 被 reset）：`https://ghproxy.net/https://raw.githubusercontent.com/hu568/zjooc-auto/main/zjooc-auto.user.js`

另外 `https://github.com/.../raw/...` 会 302 跳到 `raw.githubusercontent.com`，国内同样会被 reset，所以也建议直接用镜像地址。

**Q：OCS 启动时一直卡在"正在安装用户脚本…"？**

不要用 OCS 的「添加本地脚本」（内部拼的是 `file://` 地址，扩展默认无文件访问权限），改用上面的网络脚本地址。

## 已知限制

- 个别课程使用第三方播放器（`resourceUrl` 含 `moocollege.com`，可能在 iframe 里）。脚本找不到 `video` 会等待 25s 后**暂停并提示**，不会瞎点「完成」跳过未观看的视频。
- 人脸识别 / 验证码等身份核验无法处理，需要人工。
- 服务端反作弊规则未知：建议倍速 ≤ 2x，不要短时间刷完大量课程。
- 站点改版会使选择器失效；面板日志会显示「未找到…」，欢迎提 issue 附日志。

## 免责声明

本项目仅供学习交流与自动化技术研究使用。使用自动化脚本可能违反平台服务条款，由此产生的后果（包括但不限于课程成绩、账号处罚）由使用者自行承担。
请优先遵守学校与平台的规章制度。

## License

[MIT](LICENSE)
